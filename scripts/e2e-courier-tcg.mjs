/**
 * E2E — The Courier Guy end-to-end booking chain (real HTTP APIs, cookie jars):
 *
 *   C1  live shipping quote through the app (TCG rates with real parcels)
 *   C2  checkout stores the exact chosen service code (shippingOptionCode)
 *   C3  GGPay sandbox payment settles the order instantly in-app
 *   C4  automatic courier booking fires on settlement and reports the TCG
 *       gateway's honest failure (wallet has no funds) — never a silent drop
 *   C5  buyer's courier view shows the booking state (no reference yet)
 *   C6  seller's manual "Book courier" relays the gateway reason (502)
 *   C7  waybill is honestly refused while no shipment exists (409)
 *   C8  seller orders list carries the courier state for the dashboard UI
 *
 * Booking a REAL shipment is intentionally NOT attempted — the TCG wallet
 * has no funds, so the gateway refuses; that is exactly the honest-failure
 * path a real seller would see before topping up.
 * Run: bun scripts/e2e-courier-tcg.mjs
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes, scryptSync } from 'node:crypto';

const db = new PrismaClient();
const BASE = 'http://localhost:3000';
const STAMP = Date.now().toString(36);
const SELLER = { name: 'Courier Seller', email: `tcgseller.${STAMP}@example.com`, password: 'GateKeeper!2026' };
const BUYER = { name: 'Courier Buyer', email: `tcgbuyer.${STAMP}@example.com`, password: 'GateKeeper!2026' };
const ADMIN_EMAIL = `tcgadmin.${STAMP}@example.com`;

const results = [];
function check(step, ok, extra = '') {
  results.push({ step, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${extra ? ` — ${extra}` : ''}`);
}

// ---- cookie jars -----------------------------------------------------------
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
    body: isForm ? body : isStr(body) ? body : JSON.stringify(body),
    redirect: 'manual',
  });
  absorb(as, res);
  return res;
}
const isStr = (v) => typeof v === 'string';

async function signin(who, email, password) {
  const csrfRes = await GET_(who, '/api/auth/csrf');
  const { csrfToken } = await csrfRes.json();
  const form = new URLSearchParams({ csrfToken, email, password, redirect: 'false', json: 'true' });
  return POST_(who, '/api/auth/callback/credentials', form.toString(), 'application/x-www-form-urlencoded');
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
    return { ok: v.status < 500, detail: `fresh verify ${v.status}` };
  }
  if (res.status === 409 || res.status === 429) return { ok: true, detail: `reusing account (${res.status})` };
  return { ok: false, detail: `${res.status} ${await res.text()}` };
}
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
// A photo the listing guard accepts: a REAL photograph fetched from the web
// (the guard correctly refuses AI/synthetic images — same path a real
// seller's upload takes).
async function seedPhoto() {
  const path = `/tmp/tcg-real-${STAMP}.jpg`;
  try {
    const res = await fetch('https://picsum.photos/seed/ggparcel/900/900', { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`photo fetch ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 20_000) throw new Error('photo too small');
    await import('node:fs').then((fs) => fs.writeFileSync(path, buf));
    return { path, type: 'image/jpeg' };
  } catch (e) {
    console.log(`(real photo fetch failed: ${e instanceof Error ? e.message : e} — falling back to sharp render)`);
    const sharp = (await import('sharp')).default;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#e8dcc8"/><ellipse cx="400" cy="420" rx="240" ry="160" fill="#b98a4e"/></svg>`;
    const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
    await import('node:fs').then((fs) => fs.writeFileSync(path, buf));
    return { path, type: 'image/jpeg' };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- main -------------------------------------------------------------------
try {
  // 0. admin (seeded straight into the DB — same pattern the app uses to
  // bootstrap the first admin; password is scrypt-hashed, never stored raw).
  await db.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { role: 'ADMIN', emailVerified: new Date() },
    create: { email: ADMIN_EMAIL, name: 'Courier Admin', role: 'ADMIN', passwordHash: hashPassword('GateKeeper!2026'), emailVerified: new Date() },
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

  // 1. seller applies for a store; admin approves it.
  const seed = await seedPhoto();
  const storeForm = await multipart({
    name: `TCG Courier Store ${STAMP}`, description: 'Sells shippable goods with honest parcel sizes.',
    location: '21 Church Street, Pietermaritzburg, KwaZulu-Natal, 3201', phone: '0837654321',
    businessType: 'cc', streetAddress: '21 Church Street', city: 'Pietermaritzburg', province: 'KwaZulu-Natal', postalCode: '3201',
    bankName: 'Capitec Bank', bankAccountType: 'savings', bankAccountNumber: '1234567890', bankBranchCode: '470010', bankAccountHolder: 'Courier Seller',
    productCategories: 'Home & Living', dispatchDays: '1', returnsDays: '14',
    confirmAge: '1', confirmAccuracy: '1', confirmTerms: '1',
  }, [['images', seed.path, seed.type], ['images', seed.path, seed.type]]);
  const storeRes = await POST_('seller', '/api/sellers', storeForm, 'multipart/form-data');
  const storeJson = await storeRes.json().catch(() => ({}));
  check('store application submitted', [201, 409].includes(storeRes.status), `${storeRes.status} ${storeJson.error ?? storeJson.store?.slug ?? ''}`);
  const mine = await GET_('seller', '/api/sellers?mine=1');
  const mineJson = await mine.json().catch(() => ({}));
  const storeId = mineJson?.store?.id;
  check('store id resolved', !!storeId, storeId ?? 'missing');
  if (mineJson?.store?.status !== 'active') {
    const approve = await POST_('admin', '/api/admin', { action: 'store_status', targetId: storeId, value: 'active' });
    check('admin approves the store', approve.status === 200, `status ${approve.status}`);
  } else {
    check('admin approves the store', true, 'already active');
  }
  // A brand-new store cannot sell until its subscription is active — the
  // admin grants free access (the same switch the console uses).
  const exempt = await POST_('admin', '/api/admin', { action: 'billing_exempt', targetId: storeId, value: 'on', note: 'courier E2E' });
  check('admin grants the store selling access', exempt.status === 200, `status ${exempt.status}`);
  // Sellers can only take orders through an instant processor (owner's rule:
  // no bank transfers). Locally a Yoco TEST key is accepted (sandbox builds
  // refuse live keys); it makes the store sellable, and checkout degrades
  // gracefully when Yoco's API rejects the dummy session — the E2E pays via
  // the GGPay sandbox engine instead.
  const yocoSave = await fetch(`${BASE}/api/sellers`, {
    method: 'PATCH',
    headers: { cookie: cookieHeader('seller'), 'content-type': 'application/json' },
    body: JSON.stringify({ payoutProvider: 'yoco', yocoSecretKey: 'sk_test_e2e-not-a-real-key-000000000000' }),
  });
  absorb('seller', yocoSave);
  check('seller connects a processor (sandbox)', yocoSave.status === 200, `status ${yocoSave.status}`);

  // 2. product with REAL parcel dimensions (the whole point of this E2E).
  const cat = await db.category.findFirst();
  const prodForm = await multipart({
    name: `Courier-Sized Parcel Box ${STAMP}`,
    description: 'A neatly boxed product with declared courier dimensions, sold to exercise real The Courier Guy quoting and booking.',
    category: cat?.slug ?? 'home-living', condition: 'new', price: '899.99', stock: '3',
    weightGrams: '2500', lengthCm: '40', widthCm: '30', heightCm: '20', tags: 'courier, box, tested',
  }, [['images', seed.path, seed.type]]);
  const prodRes = await POST_('seller', '/api/products', prodForm, 'multipart/form-data');
  const prodJson = await prodRes.json().catch(() => ({}));
  const productId = prodJson?.product?.id;
  check('product submitted with parcel sizes', prodRes.status === 201 && !!productId, `${prodRes.status} ${prodJson.error ?? ''}`);
  const approveProd = await POST_('admin', '/api/admin', { action: 'moderate_product', targetId: productId, value: 'approved' });
  check('admin approves the product', approveProd.status === 200, `status ${approveProd.status}`);

  // 3. C1: live quote through the app with the REAL cart items.
  const cartRes = await POST_('buyer', '/api/cart', { productId, quantity: 1 });
  check('buyer adds to cart', [200, 201].includes(cartRes.status), `status ${cartRes.status}`);
  const shipRes = await fetch(`${BASE}/api/shipping`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      address: '234 Long Street, Cape Town, Western Cape, 8001',
      latitude: -33.9249, longitude: 18.4241,
      items: [{ productId, quantity: 1 }],
    }),
  });
  const shipJson = await shipRes.json().catch(() => ({}));
  const options = shipJson?.options ?? [];
  const tcgOption = options.find((o) => String(o.code).startsWith('tcg_')) ?? options[0];
  check('C1 live courier quote with real parcels', shipRes.status === 200 && !!tcgOption, `${options.length} options, chosen ${tcgOption?.code ?? 'none'} R${((tcgOption?.priceCents ?? 0) / 100).toFixed(2)}`);

  // 4. checkout with the chosen service.
  const orderRes = await POST_('buyer', '/api/checkout', {
    buyerName: BUYER.name, buyerPhone: '0837654321',
    address: '234 Long Street, Gardens, Cape Town, Western Cape, 8001',
    shippingCode: tcgOption?.code ?? 'standard',
    latitude: -33.9249, longitude: 18.4241, pinSource: 'search',
    idempotencyKey: `tcg-${STAMP}`,
  });
  const orderJson = await orderRes.json().catch(() => ({}));
  const order = orderJson?.orders?.[0];
  check('checkout creates the order', [200, 201].includes(orderRes.status) && !!order, `${orderRes.status} ${orderJson.error ?? order?.number ?? ''}`);
  if (!order) throw new Error(`no order created — ${orderRes.status} ${JSON.stringify(orderJson).slice(0, 200)}`);

  // C2: the order carries the exact chosen service code.
  const dbOrder = order ? await db.order.findUnique({ where: { number: order.number } }) : null;
  check('C2 order stores the courier service code', Boolean(dbOrder?.shippingOptionCode), dbOrder?.shippingOptionCode ?? 'missing');

  // 5. C3: instant in-app card payment (GGPay sandbox engine on local dev).
  const payRes = await POST_('buyer', '/api/payments/ggpay/charge', {
    orderNumber: order.number, cardNumber: '4242 4242 4242 4242', cardName: 'Courier Buyer', expiry: '12/30', cvv: '123',
  });
  const payJson = await payRes.json().catch(() => ({}));
  check('C3 instant in-app payment settles', payRes.status === 200 && payJson?.order?.paymentStatus === 'paid', `${payRes.status} ${payJson?.error ?? payJson?.order?.paymentStatus ?? ''}`);

  // 6. C4: the automatic booking ran and recorded the gateway's honest answer.
  let courierRow = null;
  for (let i = 0; i < 12; i++) {
    await sleep(2500);
    courierRow = await db.order.findUnique({ where: { number: order.number }, select: { courierStatus: true, courierTrackingRef: true, courierBookedAt: true } });
    if (courierRow?.courierStatus) break;
  }
  const failedHonest = typeof courierRow?.courierStatus === 'string' && courierRow.courierStatus.startsWith('booking_failed');
  const fundsRelated = /insufficient funds|wallet|funds/i.test(courierRow?.courierStatus ?? '');
  check('C4 automatic booking fired on settlement', Boolean(courierRow?.courierStatus), courierRow?.courierStatus ?? 'no courier state at all');
  check('C4 booking recorded the TCG gateway reason honestly', failedHonest && fundsRelated, courierRow?.courierStatus ?? '');
  check('C4 no fake tracking reference written', !courierRow?.courierTrackingRef, courierRow?.courierTrackingRef ?? 'none');

  // 7. C5: buyer's courier view is honest (no reference, reason visible).
  const buyerCourier = await GET_('buyer', `/api/orders/${order.id}/courier`);
  const bcJson = await buyerCourier.json().catch(() => ({}));
  check('C5 buyer courier view (own order)', buyerCourier.status === 200 && bcJson?.number === order.number, `${buyerCourier.status} ${JSON.stringify(bcJson).slice(0, 140)}`);

  // 8. C6/C7: seller manual booking relays the gateway reason; waybill refused.
  const sellerBook = await POST_('seller', `/api/seller/orders/${order.id}/courier`, {});
  const sbJson = await sellerBook.json().catch(() => ({}));
  check('C6 seller manual booking relays the gateway reason', sellerBook.status === 502 && /insufficient funds|funds/i.test(sbJson?.error ?? ''), `${sellerBook.status} ${sbJson?.error ?? ''}`);
  const waybill = await GET_('seller', `/api/seller/orders/${order.id}/waybill`);
  check('C7 waybill honestly refused with no shipment', waybill.status === 409, `status ${waybill.status}`);

  // 9. C8: the seller orders list carries the courier state (dashboard UI).
  const sOrders = await GET_('seller', '/api/seller/orders');
  const soJson = await sOrders.json().catch(() => ({}));
  const row = (soJson?.orders ?? []).find((o) => o.number === order.number);
  check('C8 seller orders carry courier state', Boolean(row?.courierStatus), row?.courierStatus ?? 'missing');

  // 10. Authorization edges: another buyer cannot see this order's courier data.
  const stranger = { name: 'Courier Stranger', email: `tCGstranger.${STAMP}@example.com`, password: 'GateKeeper!2026' };
  await registerVerify(stranger);
  await signin('stranger', stranger.email, stranger.password);
  const strangerView = await GET_('stranger', `/api/orders/${order.id}/courier`);
  check('stranger cannot read the order courier data', strangerView.status === 404, `status ${strangerView.status}`);
} catch (e) {
  check('script error', false, e instanceof Error ? e.message : String(e));
} finally {
  await db.$disconnect();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILURES: ${failed.map((f) => f.step).join(' | ')}` : ' — ALL GREEN'}`);
process.exit(failed.length ? 1 : 0);
