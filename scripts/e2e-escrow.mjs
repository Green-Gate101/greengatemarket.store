/**
 * E2E — Escrow wallet end-to-end (the "in-app wallet that holds seller money
 * until the parcel ships" system):
 *
 *   W1  settlement splits the money into the ledger: seller escrow HELD,
 *       courier budget (shipping), commission — platform cash nets to zero
 *   W2  admin Finance payload carries balances + the held payout
 *   W3  escrow guard: a payout still in escrow CANNOT be marked processing
 *   W4  seller earnings view shows "held" honestly
 *   W5  sweep honesty: a booked order WITHOUT a collection proof stays held
 *   W6  48h auto-release (no contrary scan) frees the earnings + payout
 *   W7  payout transitions process → paid once released; ledger moves the
 *       money to seller_paid; earnings view agrees
 *   W8  admin manual release (release_payout) works exactly once
 *   W9  auth edges: buyers cannot read earnings/admin; unauth refused
 *
 * Run: node scripts/e2e-escrow.mjs   (dev server on :3000, GGPay sandbox)
 *
 * IMPORTANT — run with NODE, not bun: Bun's fetch keeps an automatic cookie
 * jar per process, which leaks cookies between the four actors (admin /
 * seller / buyer / anon) and corrupts NextAuth's csrf round-trip
 * (sign-ins then bounce with `?csrf=true`). Node's fetch does not auto-manage
 * cookies, so the manual per-actor cookie jars below are authoritative.
 */
if (typeof Bun !== 'undefined') {
  console.error('✗ Run this E2E with node (not bun) — bun\'s fetch auto-cookie-jar breaks multi-user sign-ins.');
  process.exit(2);
}
import { PrismaClient } from '@prisma/client';
import { randomBytes, scryptSync } from 'node:crypto';

const db = new PrismaClient();
const BASE = 'http://localhost:3000';
const STAMP = Date.now().toString(36);
const SELLER = { name: 'Escrow Seller', email: `escrow.seller.${STAMP}@example.com`, password: 'GateKeeper!2026' };
const BUYER = { name: 'Escrow Buyer', email: `escrow.buyer.${STAMP}@example.com`, password: 'GateKeeper!2026' };
const ADMIN_EMAIL = `escrow.admin.${STAMP}@example.com`;

const results = [];
function check(step, ok, extra = '') {
  results.push({ step, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${extra ? ` — ${extra}` : ''}`);
}

const jars = new Map();
function jar(name) { if (!jars.has(name)) jars.set(name, []); return jars.get(name); }
function cookieHeader(name) { return jar(name).map((c) => `${c.split('=')[0]}=${c.split('=')[1]?.split(';')[0]}`).join('; '); }
function absorb(name, res) {
  for (const c of (res.headers.getSetCookie?.() ?? [])) {
    const key = c.split('=')[0];
    const list = jar(name);
    const idx = list.findIndex((x) => x.startsWith(`${key}=`));
    if (idx >= 0) list[idx] = c; else list.push(c);
  }
}
async function GET_(as, path) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: cookieHeader(as) }, redirect: 'manual' });
  absorb(as, res);
  return res;
}
async function POST_(as, path, body, contentType) {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { cookie: cookieHeader(as), ...(isForm ? {} : { 'content-type': contentType ?? 'application/json' }) },
    body: isForm ? body : typeof body === 'string' ? body : JSON.stringify(body),
    redirect: 'manual',
  });
  absorb(as, res);
  return res;
}
async function PATCH_(as, path, body) {
  const res = await fetch(`${BASE}${path}`, { method: 'PATCH', headers: { cookie: cookieHeader(as), 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' });
  absorb(as, res);
  return res;
}
async function signin(who, email, password) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const csrfRes = await GET_(who, '/api/auth/csrf');
    const { csrfToken } = await csrfRes.json();
    const form = new URLSearchParams({ csrfToken, email, password, redirect: 'false', json: 'true' });
    const res = await POST_(who, '/api/auth/callback/credentials', form.toString(), 'application/x-www-form-urlencoded');
    if (attempt === 1) {
      const ck = jar(who).find((c) => c.includes('csrf-token'));
      console.log(`  DEBUG ${who}: csrf-cookie="${ck?.slice(0, 70) ?? 'NONE'}" posted="${csrfToken.slice(0, 30)}"`);
      console.log(`  DEBUG wire: POST ${BASE}/api/auth/callback/credentials`);
      console.log(`  DEBUG wire: cookie="${cookieHeader(who).slice(0, 120)}"`);
      console.log(`  DEBUG wire: body="${form.toString().slice(0, 160)}"`);
    }
    const sessionCookie = jar(who).find((c) => c.startsWith('next-auth.session-token='));
    const hasSession = Boolean(sessionCookie && sessionCookie.split('=')[1]?.split(';')[0]?.length > 10);
    if (hasSession) return res;
    console.log(`  (sign-in ${who} attempt ${attempt}: ${res.status} → ${res.headers.get('location') ?? 'no location'} — no valid session cookie, retrying)`);
    if (res.status !== 200 && res.status !== 302) console.log('  body:', (await res.text()).slice(0, 200));
    await sleep(1500 * attempt);
  }
  return POST_(who, '/api/auth/callback/credentials', new URLSearchParams({ csrfToken: 'retry', email, password, redirect: 'false', json: 'true' }).toString(), 'application/x-www-form-urlencoded');
}
async function multipart(fields, files = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  for (const [k, path, type] of files) {
    const buf = await import('node:fs').then((fs) => fs.readFileSync(path));
    fd.append(k, new Blob([buf], { type }), path.split('/').pop());
  }
  return fd;
}
async function registerVerify(user) {
  const res = await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(user) });
  if (res.status === 201) {
    const row = await db.authToken.findFirst({ where: { identifier: user.email, purpose: 'email_verify' }, orderBy: { expires: 'desc' } });
    if (!row) return { ok: false, detail: 'no verification token in db' };
    const v = await fetch(`${BASE}/api/auth/verify?token=${row.token}`, { redirect: 'manual' });
    return { ok: v.status < 500, detail: `verify ${v.status}` };
  }
  if (res.status === 409 || res.status === 429) return { ok: true, detail: `reusing account (${res.status})` };
  return { ok: false, detail: `${res.status} ${await res.text()}` };
}
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
async function seedPhoto() {
  const path = `/tmp/escrow-${STAMP}.jpg`;
  try {
    const res = await fetch('https://picsum.photos/seed/ggescrow/900/900', { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`photo fetch ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 20_000) throw new Error('photo too small');
    await import('node:fs').then((fs) => fs.writeFileSync(path, buf));
    return { path, type: 'image/jpeg' };
  } catch {
    const sharp = (await import('sharp')).default;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#e8dcc8"/><ellipse cx="400" cy="420" rx="240" ry="160" fill="#b98a4e"/></svg>`;
    const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
    await import('node:fs').then((fs) => fs.writeFileSync(path, buf));
    return { path, type: 'image/jpeg' };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (c) => `R${(c / 100).toFixed(2)}`;

async function payOrder(orderNumber) {
  return POST_('buyer', '/api/payments/ggpay/charge', {
    orderNumber, cardNumber: '4242 4242 4242 4242', cardName: 'Escrow Buyer', expiry: '12/30', cvv: '123',
  });
}

// ---- main -------------------------------------------------------------------
try {
  // 0. admin + seller + buyer
  await db.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { role: 'ADMIN', emailVerified: new Date() },
    create: { email: ADMIN_EMAIL, name: 'Escrow Admin', role: 'ADMIN', passwordHash: hashPassword('GateKeeper!2026'), emailVerified: new Date() },
  });
  const aIn = await signin('admin', ADMIN_EMAIL, 'GateKeeper!2026');
  check('admin sign-in', [200, 302].includes(aIn.status), `status ${aIn.status}`);
  for (const u of [SELLER, BUYER]) {
    const r = await registerVerify(u);
    check(`register+verify ${u.email}`, r.ok, r.detail);
  }
  const sIn = await signin('seller', SELLER.email, SELLER.password);
  check('seller sign-in', [200, 302].includes(sIn.status), `status ${sIn.status}`);
  const bIn = await signin('buyer', BUYER.email, BUYER.password);
  check('buyer sign-in', [200, 302].includes(bIn.status), `status ${bIn.status}`);

  // 1. store + selling access + processor (same path as the courier e2e)
  const seed = await seedPhoto();
  const storeForm = await multipart({
    name: `Escrow Wallet Store ${STAMP}`, description: 'Sells shippable goods through the in-app escrow wallet.',
    location: '12 Market Street, Johannesburg, Gauteng, 2001', phone: '0831234567',
    businessType: 'cc', streetAddress: '12 Market Street', city: 'Johannesburg', province: 'Gauteng', postalCode: '2001',
    bankName: 'FNB', bankAccountType: 'cheque', bankAccountNumber: '9876543210', bankBranchCode: '250655', bankAccountHolder: 'Escrow Seller',
    productCategories: 'Home & Living', dispatchDays: '1', returnsDays: '14',
    confirmAge: '1', confirmAccuracy: '1', confirmTerms: '1',
  }, [['images', seed.path, seed.type], ['images', seed.path, seed.type]]);
  await POST_('seller', '/api/sellers', storeForm, 'multipart/form-data');
  const mine = await (await GET_('seller', '/api/sellers?mine=1')).json().catch(() => ({}));
  const storeId = mine?.store?.id;
  check('store ready', !!storeId, storeId ?? 'missing');
  if (mine?.store?.status !== 'active') {
    const approve = await POST_('admin', '/api/admin', { action: 'store_status', targetId: storeId, value: 'active' });
    check('admin approves the store', approve.status === 200, `status ${approve.status}`);
  }
  const exempt = await POST_('admin', '/api/admin', { action: 'billing_exempt', targetId: storeId, value: 'on', note: 'escrow E2E' });
  check('admin grants selling access', exempt.status === 200, `status ${exempt.status}`);
  const yocoSave = await fetch(`${BASE}/api/sellers`, {
    method: 'PATCH',
    headers: { cookie: cookieHeader('seller'), 'content-type': 'application/json' },
    body: JSON.stringify({ payoutProvider: 'yoco', yocoSecretKey: 'sk_test_e2e-not-a-real-key-000000000000' }),
  });
  absorb('seller', yocoSave);
  check('seller connects a processor (sandbox)', yocoSave.status === 200, `status ${yocoSave.status}`);

  // 2. product
  const cat = await db.category.findFirst();
  const prodForm = await multipart({
    name: `Escrow Parcel Product ${STAMP}`,
    description: 'A boxed product sold through the in-app wallet so its money can be tracked through escrow.',
    category: cat?.slug ?? 'home-living', condition: 'new', price: '500.00', stock: '5',
    weightGrams: '1500', lengthCm: '30', widthCm: '20', heightCm: '15', tags: 'escrow, wallet, tested',
  }, [['images', seed.path, seed.type]]);
  const prodRes = await POST_('seller', '/api/products', prodForm, 'multipart/form-data');
  const prodJson = await prodRes.json().catch(() => ({}));
  const productId = prodJson?.product?.id;
  check('product created', prodRes.status === 201 && !!productId, `${prodRes.status} ${prodJson.error ?? ''}`);
  const approveProd = await POST_('admin', '/api/admin', { action: 'moderate_product', targetId: productId, value: 'approved' });
  check('admin approves the product', approveProd.status === 200, `status ${approveProd.status}`);

  // 3. order 1: cart → checkout → instant GGPay sandbox payment
  await POST_('buyer', '/api/cart', { productId, quantity: 1 });
  const orderRes = await POST_('buyer', '/api/checkout', {
    buyerName: BUYER.name, buyerPhone: '0831234567',
    address: '234 Long Street, Gardens, Cape Town, Western Cape, 8001',
    shippingCode: 'standard', idempotencyKey: `escrow1-${STAMP}`,
  });
  const orderJson = await orderRes.json().catch(() => ({}));
  const order = orderJson?.orders?.[0];
  check('order 1 created', [200, 201].includes(orderRes.status) && !!order, `${orderRes.status} ${orderJson.error ?? order?.number ?? ''}`);
  const payRes = await payOrder(order.number);
  const payJson = await payRes.json().catch(() => ({}));
  check('instant in-app payment settles (GGPay sandbox)', payRes.status === 200 && payJson?.order?.paymentStatus === 'paid', `${payRes.status} ${payJson?.error ?? ''}`);

  const dbOrder = await db.order.findUnique({ where: { number: order.number } });
  const payout = await db.payout.findUnique({ where: { orderId: dbOrder.id } });
  const subtotal = dbOrder.subtotalCents;
  const feeCents = Math.round((subtotal * 5) / 100); // platform default fee
  const netCents = subtotal - feeCents;

  // W1 — the settlement split is in the ledger
  const entries = await db.ledgerEntry.findMany({
    where: { refType: 'order', refId: dbOrder.id },
    include: { account: true },
  });
  const escrowCredit = entries.find((e) => e.account.kind === 'seller_escrow' && e.direction === 'credit');
  const shipCredit = entries.find((e) => e.account.kind === 'platform_shipping' && e.direction === 'credit');
  const feeCredit = entries.find((e) => e.account.kind === 'platform_fees' && e.direction === 'credit');
  const cashEntries = entries.filter((e) => e.account.kind === 'platform_cash');
  const cashNet = cashEntries.reduce((s, e) => s + (e.direction === 'credit' ? e.amountCents : -e.amountCents), 0);
  check('W1 escrow holds the seller net (state held)', !!escrowCredit && escrowCredit.amountCents === netCents && escrowCredit.state === 'held',
    escrowCredit ? `${money(escrowCredit.amountCents)} state=${escrowCredit.state} (expected ${money(netCents)})` : 'no escrow entry');
  check('W1 courier budget = buyer shipping fee', !!shipCredit && shipCredit.amountCents === dbOrder.shippingCents,
    shipCredit ? money(shipCredit.amountCents) : 'no shipping entry');
  check('W1 commission recorded', !!feeCredit && feeCredit.amountCents === feeCents,
    feeCredit ? money(feeCredit.amountCents) : 'no fee entry');
  check('W1 platform cash nets to zero (no discount)', cashNet === 0, money(cashNet));
  check('W1 payout queued and held', !!payout && payout.releasedAt === null && payout.status === 'pending',
    payout ? `releasedAt=${String(payout.releasedAt)}` : 'no payout row');

  // W2 — admin Finance payload
  const adminData = await (await GET_('admin', '/api/admin')).json().catch(() => ({}));
  check('W2 finance payload present', !!adminData?.finance && Array.isArray(adminData.finance.recent), `balances=${adminData?.finance?.balances?.length ?? '∅'}`);
  check('W2 escrow held total includes this order', (adminData?.finance?.escrowHeldCents ?? 0) >= netCents, money(adminData?.finance?.escrowHeldCents ?? 0));
  const prow = (adminData?.payoutRows ?? []).find((r) => r.id === payout.id);
  check('W2 payout row flags escrow', !!prow && prow.held === true && prow.releasedAt === null, prow ? `held=${prow.held}` : 'row missing');

  // W3 — escrow guard blocks the payout transition
  const early = await PATCH_('admin', '/api/payouts', { payoutId: payout.id, status: 'processing' });
  check('W3 payout still in escrow refused (409)', early.status === 409, `${early.status} ${(await early.json().catch(() => ({})))?.error ?? ''}`);

  // W4 — seller earnings view
  const earn1 = await (await GET_('seller', '/api/seller/earnings')).json().catch(() => ({}));
  const earnRow1 = (earn1?.payouts ?? []).find((p) => p.id === payout.id);
  check('W4 seller sees held earnings', earn1?.heldCents === netCents && earnRow1?.escrow === 'held', `held=${money(earn1?.heldCents ?? 0)}`);

  // W5 — sweep honesty: booked but NO proof stays held
  await db.order.update({
    where: { id: dbOrder.id },
    data: { courierTrackingRef: `E2EESC${STAMP.toUpperCase()}`, courierStatus: 'booked', courierBookedAt: new Date() },
  });
  await GET_('seller', '/api/seller/orders'); // fires the release sweep
  await sleep(3000);
  const afterSweep1 = await db.payout.findUnique({ where: { id: payout.id } });
  check('W5 no collection proof → stays held', afterSweep1.releasedAt === null, `releasedAt=${String(afterSweep1.releasedAt)}`);

  // W6 — 48h auto-release frees the money
  await db.order.update({
    where: { id: dbOrder.id },
    data: { courierBookedAt: new Date(Date.now() - 49 * 3600_000) },
  });
  await GET_('seller', '/api/seller/orders'); // fires the release sweep
  await sleep(3000);
  const afterSweep2 = await db.payout.findUnique({ where: { id: payout.id } });
  const escrowAfter = await db.ledgerEntry.findFirst({ where: { id: escrowCredit.id } });
  check('W6 48h auto-release fired', !!afterSweep2.releasedAt, `releasedAt=${String(afterSweep2.releasedAt)}`);
  check('W6 escrow entry flipped to released', escrowAfter.state === 'released', `state=${escrowAfter.state}`);

  // W7 — payout transitions now allowed; ledger pays out; earnings agree
  const proc = await PATCH_('admin', '/api/payouts', { payoutId: payout.id, status: 'processing' });
  check('W7 released payout can be marked processing', proc.status === 200, `status ${proc.status}`);
  const paid = await PATCH_('admin', '/api/payouts', { payoutId: payout.id, status: 'paid' });
  check('W7 released payout can be marked paid', paid.status === 200, `status ${paid.status}`);
  const payoutLegs = await db.ledgerEntry.findMany({
    where: { refType: 'payout', refId: payout.id },
    include: { account: true },
  });
  const paidCredit = payoutLegs.find((l) => l.account.kind === 'seller_paid' && l.direction === 'credit');
  const escrowDebit = payoutLegs.find((l) => l.account.kind === 'seller_escrow' && l.direction === 'debit');
  check('W7 ledger moved earnings to seller_paid (escrow debited, paid credited)',
    !!paidCredit && !!escrowDebit && paidCredit.amountCents === netCents && escrowDebit.amountCents === netCents,
    `legs=${payoutLegs.map((l) => `${l.account.kind}:${l.direction}:${money(l.amountCents)}`).join(' ') || 'none'}`);
  const earn2 = await (await GET_('seller', '/api/seller/earnings')).json().catch(() => ({}));
  check('W7 seller earnings show paid out', earn2?.paidCents === netCents, `paid=${money(earn2?.paidCents ?? 0)}`);

  // W8 — admin manual release on a second held order (exactly once)
  await POST_('buyer', '/api/cart', { productId, quantity: 1 });
  const order2Res = await POST_('buyer', '/api/checkout', {
    buyerName: BUYER.name, buyerPhone: '0831234567',
    address: '234 Long Street, Gardens, Cape Town, Western Cape, 8001',
    shippingCode: 'standard', idempotencyKey: `escrow2-${STAMP}`,
  });
  const order2 = (await order2Res.json().catch(() => ({})))?.orders?.[0];
  check('order 2 created', [200, 201].includes(order2Res.status) && !!order2, `${order2Res.status} ${order2?.number ?? ''}`);
  const pay2 = await payOrder(order2.number);
  check('order 2 paid instantly', pay2.status === 200, `status ${pay2.status}`);
  const dbOrder2 = await db.order.findUnique({ where: { number: order2.number } });
  const payout2 = await db.payout.findUnique({ where: { orderId: dbOrder2.id } });
  const rel1 = await POST_('admin', '/api/admin', { action: 'release_payout', targetId: payout2.id });
  check('W8 admin manual release works', rel1.status === 200, `status ${rel1.status}`);
  const rel2 = await POST_('admin', '/api/admin', { action: 'release_payout', targetId: payout2.id });
  check('W8 double release honestly refused', rel2.status === 409, `status ${rel2.status}`);

  // W9 — auth edges
  const buyerEarnings = await GET_('buyer', '/api/seller/earnings');
  check('W9 buyer cannot read seller earnings', [401, 403].includes(buyerEarnings.status), `status ${buyerEarnings.status}`);
  const anonAdmin = await fetch(`${BASE}/api/admin`);
  check('W9 unauthenticated admin refused', [401, 403].includes(anonAdmin.status), `status ${anonAdmin.status}`);
  const buyerPatch = await PATCH_('buyer', '/api/payouts', { payoutId: payout2.id, status: 'paid' });
  check('W9 buyer cannot transition payouts', [401, 403].includes(buyerPatch.status), `status ${buyerPatch.status}`);
} catch (e) {
  check('script error', false, e instanceof Error ? e.message : String(e));
} finally {
  await db.$disconnect();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILURES: ${failed.map((f) => f.step).join(' | ')}` : ' — ALL GREEN'}`);
process.exit(failed.length ? 1 : 0);
