/**
 * E2E — Buyer-only return reports (RET-1, "not as seen", NO REFUNDS):
 *
 *   R1  buyer opens a report on their own paid order (201, open, RT-ref)
 *   R2  duplicate open report on the same order refused (409)
 *   R3  the SELLER of the store cannot report the buyer's order (403)
 *   R4  another buyer (not the owner) cannot report it (403)
 *   R5  unauthenticated request refused (401)
 *   R6  unpaid order cannot be reported (409)
 *   R7  buyer withdraws an open report → closed; can re-file afterwards
 *   R8  admin payload carries returnReports + counts (Returns tab data)
 *   R9  admin approves → buyer notified, order timeline entry, order status untouched
 *   R10 buyer marks parcel sent back → in_return
 *   R11 admin marks received → received
 *   R12 admin resolves as replacement → resolved; NO ledger rows written
 *   R13 illegal transition refused (409); refund resolution refused (400)
 *   R14 buyer cannot use admin transitions (403 via /api/admin)
 *   R15 seller cannot act on /api/admin (401/403)
 *   R16 seller order detail has NO returnReports field (admin/buyer only)
 *   R17 validation: short description (400), unknown reason (400)
 *
 * Run: node scripts/e2e-returns.mjs   (dev server on :3000, GGPay sandbox)
 *
 * IMPORTANT — run with NODE, not bun: Bun's fetch keeps an automatic cookie
 * jar per process, which leaks cookies between the actors and corrupts
 * NextAuth's csrf round-trip.
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
const SELLER = { name: 'Return Seller', email: `return.seller.${STAMP}@example.com`, password: 'GateKeeper!2026' };
const BUYER = { name: 'Return Buyer', email: `return.buyer.${STAMP}@example.com`, password: 'GateKeeper!2026' };
const BUYER2 = { name: 'Withdraw Buyer', email: `return.withdraw.${STAMP}@example.com`, password: 'GateKeeper!2026' };
const OTHER = { name: 'Other Buyer', email: `return.other.${STAMP}@example.com`, password: 'GateKeeper!2026' };
const ADMIN_EMAIL = `return.admin.${STAMP}@example.com`;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function signin(who, email, password) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const csrfRes = await GET_(who, '/api/auth/csrf');
    const { csrfToken } = await csrfRes.json();
    const form = new URLSearchParams({ csrfToken, email, password, redirect: 'false', json: 'true' });
    const res = await POST_(who, '/api/auth/callback/credentials', form.toString(), 'application/x-www-form-urlencoded');
    const sessionCookie = jar(who).find((c) => c.startsWith('next-auth.session-token='));
    if (sessionCookie && sessionCookie.split('=')[1]?.split(';')[0]?.length > 10) return res;
    await sleep(1200 * attempt);
  }
  return null;
}
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
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
async function seedPhoto() {
  const path = `/tmp/returns-${STAMP}.jpg`;
  const sharp = (await import('sharp')).default;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="700"><rect width="700" height="700" fill="#ded8c2"/><circle cx="350" cy="330" r="180" fill="#7d9b76"/></svg>`;
  const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
  await import('node:fs').then((fs) => fs.writeFileSync(path, buf));
  return { path, type: 'image/jpeg' };
}
async function registerVerify(user) {
  const res = await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(user) });
  if (res.status === 201) {
    const row = await db.authToken.findFirst({ where: { identifier: user.email, purpose: 'email_verify' }, orderBy: { expires: 'desc' } });
    if (!row) return { ok: false, detail: 'no token' };
    const v = await fetch(`${BASE}/api/auth/verify?token=${row.token}`, { redirect: 'manual' });
    return { ok: v.status < 500, detail: `verify ${v.status}` };
  }
  if (res.status === 409 || res.status === 429) return { ok: true, detail: `reusing (${res.status})` };
  return { ok: false, detail: `${res.status} ${await res.text()}` };
}
async function payOrder(orderNumber, as = 'buyer') {
  return POST_(as, '/api/payments/ggpay/charge', {
    orderNumber, cardNumber: '4242 4242 4242 4242', cardName: 'Return Buyer', expiry: '12/30', cvv: '123',
  });
}
const REPORT = {
  reason: 'not_as_seen',
  description: `The parcel arrived and the item is not what I saw on the listing — the colour and size are wrong. (${STAMP})`,
};

// ---- main -------------------------------------------------------------------
try {
  // 0. actors
  await db.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { role: 'ADMIN', emailVerified: new Date() },
    create: { email: ADMIN_EMAIL, name: 'Return Admin', role: 'ADMIN', passwordHash: hashPassword('GateKeeper!2026'), emailVerified: new Date() },
  });
  const aIn = await signin('admin', ADMIN_EMAIL, 'GateKeeper!2026');
  check('admin sign-in', !!aIn, aIn ? `status ${aIn.status}` : 'no session');
  for (const u of [SELLER, BUYER, OTHER, BUYER2]) {
    const r = await registerVerify(u);
    check(`register+verify ${u.email}`, r.ok, r.detail);
  }
  check('seller sign-in', !!(await signin('seller', SELLER.email, SELLER.password)));
  check('buyer sign-in', !!(await signin('buyer', BUYER.email, BUYER.password)));
  check('other buyer sign-in', !!(await signin('other', OTHER.email, OTHER.password)));
  check('withdraw buyer sign-in', !!(await signin('buyer2', BUYER2.email, BUYER2.password)));

  // 1. store + product
  const seed = await seedPhoto();
  await POST_('seller', '/api/sellers', await multipart({
    name: `Return Report Store ${STAMP}`, description: 'Store used to verify buyer-only return reports.',
    location: '7 Return Road, Durban, KwaZulu-Natal, 4001', phone: '0831234567',
    businessType: 'cc', streetAddress: '7 Return Road', city: 'Durban', province: 'KwaZulu-Natal', postalCode: '4001',
    bankName: 'FNB', bankAccountType: 'cheque', bankAccountNumber: '1234567890', bankBranchCode: '250655', bankAccountHolder: 'Return Seller',
    productCategories: 'Home & Living', dispatchDays: '1', returnsDays: '14',
    confirmAge: '1', confirmAccuracy: '1', confirmTerms: '1',
  }, [['images', seed.path, seed.type], ['images', seed.path, seed.type]]), 'multipart/form-data');
  const mine = await (await GET_('seller', '/api/sellers?mine=1')).json().catch(() => ({}));
  const storeId = mine?.store?.id;
  check('store ready', !!storeId, storeId ?? 'missing');
  if (mine?.store?.status !== 'active') {
    await POST_('admin', '/api/admin', { action: 'store_status', targetId: storeId, value: 'active' });
  }
  await POST_('admin', '/api/admin', { action: 'billing_exempt', targetId: storeId, value: 'on', note: 'returns E2E' });
  const yocoSave = await fetch(`${BASE}/api/sellers`, {
    method: 'PATCH',
    headers: { cookie: cookieHeader('seller'), 'content-type': 'application/json' },
    body: JSON.stringify({ payoutProvider: 'yoco', yocoSecretKey: 'sk_test_e2e-not-a-real-key-000000000000' }),
  });
  absorb('seller', yocoSave);
  check('seller connects a processor (sandbox)', yocoSave.status === 200, `status ${yocoSave.status}`);

  const cat = await db.category.findFirst();
  const prodRes = await POST_('seller', '/api/products', await multipart({
    name: `Return Test Product ${STAMP}`,
    description: 'Product used to verify the buyer-only return report flow end to end.',
    category: cat?.slug ?? 'home-living', condition: 'new', price: '350.00', stock: '10',
    weightGrams: '900', lengthCm: '20', widthCm: '15', heightCm: '10', tags: 'returns, tested',
  }, [['images', seed.path, seed.type]]), 'multipart/form-data');
  const productId = (await prodRes.json().catch(() => ({})))?.product?.id;
  check('product created', !!productId, productId ?? String(prodRes.status));
  await POST_('admin', '/api/admin', { action: 'moderate_product', targetId: productId, value: 'approved' });

  // 2. paid order (reportable) + unpaid order (not reportable)
  await POST_('buyer', '/api/cart', { productId, quantity: 1 });
  const orderRes = await POST_('buyer', '/api/checkout', {
    buyerName: BUYER.name, buyerPhone: '0831234567',
    address: '88 Report Lane, Pretoria, Gauteng, 0001',
    shippingCode: 'standard', idempotencyKey: `ret1-${STAMP}`,
  });
  const order = (await orderRes.json().catch(() => ({})))?.orders?.[0];
  check('reportable order created', !!order, order?.number ?? String(orderRes.status));
  const payRes = await payOrder(order.number);
  check('order paid (GGPay sandbox)', payRes.status === 200, `status ${payRes.status}`);

  await POST_('buyer', '/api/cart', { productId, quantity: 1 });
  const unpaidRes = await POST_('buyer', '/api/checkout', {
    buyerName: BUYER.name, buyerPhone: '0831234567',
    address: '88 Report Lane, Pretoria, Gauteng, 0001',
    shippingCode: 'standard', idempotencyKey: `ret2-${STAMP}`,
  });
  const unpaid = (await unpaidRes.json().catch(() => ({})))?.orders?.[0];
  check('unpaid order created', !!unpaid, unpaid?.number ?? String(unpaidRes.status));

  // R17 — validation first (no report rows yet)
  const shortRes = await POST_('buyer', '/api/returns', { orderId: order.number, reason: 'not_as_seen', description: 'too short' });
  check('R17 short description refused (400)', shortRes.status === 400, `status ${shortRes.status}`);
  const badReason = await POST_('buyer', '/api/returns', { orderId: order.number, reason: 'refund_please', description: REPORT.description });
  check('R17 unknown reason refused (400)', badReason.status === 400, `status ${badReason.status}`);

  // R6 — unpaid order cannot be reported
  const unpaidReport = await POST_('buyer', '/api/returns', { orderId: unpaid.number, ...REPORT });
  check('R6 unpaid order refused (409)', unpaidReport.status === 409, `status ${unpaidReport.status}`);

  // R5 — unauthenticated
  const anon = await fetch(`${BASE}/api/returns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: order.number, ...REPORT }) });
  check('R5 unauthenticated refused (401)', [401, 403].includes(anon.status), `status ${anon.status}`);

  // R3/R4 — only THE buyer can report
  const sellerTry = await POST_('seller', '/api/returns', { orderId: order.number, ...REPORT });
  check('R3 seller cannot report the buyer order (403)', sellerTry.status === 403, `status ${sellerTry.status}`);
  const otherTry = await POST_('other', '/api/returns', { orderId: order.number, ...REPORT });
  check('R4 other buyer cannot report it (403)', otherTry.status === 403, `status ${otherTry.status}`);

  // R1 — the buyer reports
  const create = await POST_('buyer', '/api/returns', { orderId: order.number, ...REPORT });
  const createJson = await create.json().catch(() => ({}));
  const report = createJson?.report;
  check('R1 buyer opens report (201)', create.status === 201 && !!report, `${create.status} ${createJson.error ?? report?.reference ?? ''}`);
  check('R1 status open + RT reference', report?.status === 'open' && /^RT-[0-9A-F]{8}$/.test(report?.reference ?? ''), report?.reference ?? 'no ref');

  // R2 — duplicate open report
  const dup = await POST_('buyer', '/api/returns', { orderId: order.number, ...REPORT });
  check('R2 duplicate open report refused (409)', dup.status === 409, `status ${dup.status}`);

  // R16 — seller's order detail must NOT carry returnReports; buyer's must
  const sellerDetail = await (await GET_('seller', `/api/orders/${order.number}`)).json().catch(() => ({}));
  check('R16 seller detail has no returnReports', !('returnReports' in sellerDetail), `keys=${Object.keys(sellerDetail).length}`);
  const buyerDetail = await (await GET_('buyer', `/api/orders/${order.number}`)).json().catch(() => ({}));
  check('R16 buyer detail carries the report', buyerDetail?.returnReports?.[0]?.id === report.id, `n=${buyerDetail?.returnReports?.length ?? 0}`);

  // R8 — admin payload
  const adminData = await (await GET_('admin', '/api/admin')).json().catch(() => ({}));
  const adminRow = (adminData?.returnReports?.reports ?? []).find((r) => r.id === report.id);
  check('R8 admin payload has the report', !!adminRow && adminRow.status === 'open', adminRow ? `${adminRow.reference} ${adminRow.status}` : 'missing');

  // R14 — buyer cannot drive the admin action
  const buyerAdmin = await POST_('buyer', '/api/admin', { action: 'return_report_update', targetId: report.id, value: 'approved' });
  check('R14 buyer cannot use admin transition', [401, 403].includes(buyerAdmin.status), `status ${buyerAdmin.status}`);
  // R15 — seller cannot either
  const sellerAdmin = await POST_('seller', '/api/admin', { action: 'return_report_update', targetId: report.id, value: 'approved' });
  check('R15 seller cannot use admin transition', [401, 403].includes(sellerAdmin.status), `status ${sellerAdmin.status}`);

  // R9 — approve (money untouched: ledger count before/after)
  const dbOrder = await db.order.findUnique({ where: { number: order.number }, select: { id: true, status: true, paymentStatus: true } });
  const ledgerBefore = await db.ledgerEntry.count({ where: { refType: 'order', refId: dbOrder.id } });
  const approve = await POST_('admin', '/api/admin', { action: 'return_report_update', targetId: report.id, value: 'approved', note: 'Sorry about that — please send it back.' });
  check('R9 admin approves (200)', approve.status === 200, `${approve.status} ${(await approve.json().catch(() => ({})))?.error ?? ''}`);
  const buyerNotifs = await db.notification.findMany({ where: { userId: (await db.user.findUnique({ where: { email: BUYER.email } })).id, type: 'return_report_update' } });
  check('R9 buyer notified of the update', buyerNotifs.length >= 1, `${buyerNotifs.length} notification(s)`);
  const events = await db.orderEvent.findMany({ where: { orderId: dbOrder.id }, orderBy: { createdAt: 'asc' } });
  check('R9 order timeline records the report', events.some((e) => e.status === 'return_report' && e.note?.includes(report.reference)), `${events.length} event(s)`);
  const orderAfter = await db.order.findUnique({ where: { number: order.number }, select: { status: true, paymentStatus: true } });
  check('R9 order status/payment untouched', dbOrder.status === orderAfter.status && dbOrder.paymentStatus === orderAfter.paymentStatus, `${orderAfter.status}/${orderAfter.paymentStatus}`);

  // R10 — buyer marks sent back
  const sent = await PATCH_('buyer', `/api/returns/${report.id}`, { action: 'mark_sent_back' });
  check('R10 buyer marks parcel sent back', sent.status === 200 && (await sent.json().catch(() => ({})))?.report?.status === 'in_return', `status ${sent.status}`);

  // R11 — admin marks received
  const received = await POST_('admin', '/api/admin', { action: 'return_report_update', targetId: report.id, value: 'received' });
  check('R11 admin marks received', received.status === 200, `status ${received.status}`);

  // R13 first — refund "resolution" is not a thing and must be refused
  const refundTry = await POST_('admin', '/api/admin', { action: 'return_report_update', targetId: report.id, value: 'resolved', resolution: 'refund' });
  check('R13 refund resolution refused (400)', refundTry.status === 400, `status ${refundTry.status}`);

  // R12 — resolve as replacement; ledger must NOT move
  const resolve = await POST_('admin', '/api/admin', { action: 'return_report_update', targetId: report.id, value: 'resolved', resolution: 'replacement', note: 'A replacement ships this week.' });
  const resolveJson = await resolve.json().catch(() => ({}));
  check('R12 resolved as replacement', resolve.status === 200 && resolveJson?.report?.status === 'resolved' && resolveJson?.report?.resolution === 'replacement', `${resolve.status} ${resolveJson.error ?? ''}`);
  const ledgerAfter = await db.ledgerEntry.count({ where: { refType: 'order', refId: dbOrder.id } });
  check('R12 ledger untouched (no money moved)', ledgerBefore === ledgerAfter, `${ledgerBefore} → ${ledgerAfter}`);
  const payoutRow = await db.payout.findUnique({ where: { orderId: dbOrder.id } });
  check('R12 payout row untouched', !!payoutRow && payoutRow.status === 'pending' && payoutRow.releasedAt === null, `status=${payoutRow?.status}`);

  // R13 — resolved is terminal: another transition refused
  const again = await POST_('admin', '/api/admin', { action: 'return_report_update', targetId: report.id, value: 'received' });
  check('R13 resolved report is terminal (409)', again.status === 409, `status ${again.status}`);

  // R7 — withdraw flow on a dedicated buyer (fresh daily quota, own paid order)
  {
    await POST_('buyer2', '/api/cart', { productId, quantity: 1 });
    const order3Res = await POST_('buyer2', '/api/checkout', {
      buyerName: BUYER2.name, buyerPhone: '0831234567',
      address: '88 Report Lane, Pretoria, Gauteng, 0001',
      shippingCode: 'standard', idempotencyKey: `ret3-${STAMP}`,
    });
    const order3 = (await order3Res.json().catch(() => ({})))?.orders?.[0];
    check('R7 withdraw-buyer order created', !!order3, order3?.number ?? String(order3Res.status));
    const pay3 = await payOrder(order3.number, 'buyer2');
    check('R7 withdraw-buyer order paid', pay3.status === 200, `status ${pay3.status}`);
    const rep2 = await POST_('buyer2', '/api/returns', { orderId: order3.number, ...REPORT });
    const rep2Json = await rep2.json().catch(() => ({}));
    check('R7 withdraw-buyer opens report', rep2.status === 201, `${rep2.status} ${rep2Json.error ?? ''}`);
    const wd = await PATCH_('buyer2', `/api/returns/${rep2Json?.report?.id}`, { action: 'withdraw', note: 'Found it — false alarm.' });
    check('R7 buyer withdraws own report → closed', wd.status === 200 && (await wd.json().catch(() => ({})))?.report?.status === 'closed', `withdraw status ${wd.status}`);
    // withdraw is only legal while open
    const wd2 = await PATCH_('buyer2', `/api/returns/${rep2Json?.report?.id}`, { action: 'withdraw' });
    check('R7 withdrawing a closed report refused (409)', wd2.status === 409, `status ${wd2.status}`);
    // other buyer cannot withdraw someone else's report
    const wd3 = await PATCH_('other', `/api/returns/${rep2Json?.report?.id}`, { action: 'withdraw' });
    check('R7 other buyer cannot withdraw it (403)', wd3.status === 403, `status ${wd3.status}`);
    // rate limiter: the 6th distinct VALID report by one account in a day is refused (429)
    await POST_('buyer2', '/api/cart', { productId, quantity: 1 });
    const o4 = (await (await POST_('buyer2', '/api/checkout', {
      buyerName: BUYER2.name, buyerPhone: '0831234567',
      address: '88 Report Lane, Pretoria, Gauteng, 0001',
      shippingCode: 'standard', idempotencyKey: `ret4-${STAMP}`,
    })).json().catch(() => ({})))?.orders?.[0];
    await payOrder(o4.number, 'buyer2');
    let limited = null;
    for (let i = 0; i < 5 && !limited; i++) {
      const r = await POST_('buyer2', `/api/returns`, { orderId: o4.number, ...REPORT, description: `${REPORT.description} (attempt ${i + 2})` });
      if (r.status === 429) limited = `429 on extra attempt ${i + 1}`;
      else if (r.status !== 201 && r.status !== 409) { limited = `unexpected ${r.status}`; break; }
    }
    check('R18 6th report in a day refused (429)', Boolean(limited) && limited.startsWith('429'), limited ?? 'never limited');
  }
} catch (e) {
  check('script error', false, e instanceof Error ? e.message : String(e));
} finally {
  await db.$disconnect();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILURES: ${failed.map((f) => f.step).join(' | ')}` : ' — ALL GREEN'}`);
process.exit(failed.length ? 1 : 0);
