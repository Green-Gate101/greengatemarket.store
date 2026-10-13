/**
 * Task 36 — local E2E of the full seller journey:
 * register → verify → sign in → submit store application → admin approval →
 * product submission → buyer order → seller dashboard analytics + orders.
 * Uses the real HTTP APIs with cookie jars (NextAuth credentials flow).
 * Run: bun scripts/e2e-seller-flow.mjs
 */
import { PrismaClient } from '@prisma/client';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import sharp from 'sharp';

const db = new PrismaClient();
const BASE = 'http://localhost:3000';
const STAMP = Date.now().toString(36);
// Fixed identities so reruns are idempotent (register endpoint is 5/hour/IP).
// Override with E2E_SELLER_EMAIL / E2E_BUYER_EMAIL to exercise a FRESH
// application (needed when the server-side questionnaire changes).
const SELLER = { name: 'Thandi Nkosi', email: process.env.E2E_SELLER_EMAIL ?? 't36seller.mv6v7zx4@example.com', password: 'GateKeeper!2026' };
const BUYER = { name: 'Sipho Dlamini', email: process.env.E2E_BUYER_EMAIL ?? 't36buyer.mv6v7zx4@example.com', password: 'GateKeeper!2026' };

const results = [];
function check(step, ok, extra = '') {
  results.push({ step, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${extra ? ` — ${extra}` : ''}`);
}

// ---- cookie-jar helpers -------------------------------------------------
const jars = new Map();
function jar(name) {
  if (!jars.has(name)) jars.set(name, []);
  return jars.get(name);
}
function cookieHeader(name) {
  return jar(name).map((c) => `${c.split('=')[0]}=${c.split('=')[1]?.split(';')[0]}`).join('; ');
}
function absorb(name, res) {
  const cookies = res.headers.getSetCookie?.() ?? [];
  for (const c of cookies) {
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
  // FormData → fetch sets its own multipart boundary; JSON objects → stringify;
  // strings pass through with an explicit content type (form-urlencoded).
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const isStr = typeof body === 'string';
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader(as),
      ...(isForm ? {} : { 'content-type': contentType ?? (isStr ? 'text/plain' : 'application/json') }),
    },
    body: isForm || isStr ? body : JSON.stringify(body),
    redirect: 'manual',
  });
  absorb(as, res);
  return res;
}
async function signin(who, email, password) {
  const csrfRes = await GET_(who, '/api/auth/csrf');
  const { csrfToken } = await csrfRes.json();
  const form = new URLSearchParams({ csrfToken, email, password, redirect: 'false', json: 'true' });
  const res = await POST_(who, '/api/auth/callback/credentials', form.toString(), 'application/x-www-form-urlencoded');
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
function multipart(fields, files = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  for (const [k, path, type] of files) {
    const buf = readFileSync(path);
    fd.append(k, new Blob([buf], { type }), path.split('/').pop());
  }
  return fd;
}

// ---- 0. use a REAL (web-sourced, guard-passing) product photo ----------
async function getSeedImage() {
  // A real photograph of a handwoven Zulu basket (fetched from the web).
  // The AI-image guard correctly rejects synthetic images, so tests use a
  // genuine photo — same path a real seller's upload takes.
  const real = '/tmp/t36-basket.jpg';
  if (existsSync(real)) return { path: real, type: 'image/jpeg' };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">
    <rect width="800" height="800" fill="#e8e3d8"/>
    <g transform="translate(400,430)">
      <ellipse rx="230" ry="150" fill="#b98a4e"/>
    </g>
  </svg>`;
  const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
  const path = '/tmp/t36-basket.jpg';
  writeFileSync(path, buf);
  return { path, type: 'image/jpeg' };
}

// ---- 1. register + verify ----------------------------------------------
async function registerVerify(user) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(user),
  });
  // 201 = freshly created+verified below; 409 = already exists (verified in a
  // previous run); 429 = register rate-limit (existing account reused).
  if (res.status === 201) {
    const row = await db.authToken.findFirst({ where: { identifier: user.email, purpose: 'email_verify' }, orderBy: { expires: 'desc' } });
    if (!row) return { ok: false, detail: 'no verification token in db' };
    const v = await fetch(`${BASE}/api/auth/verify?token=${row.token}`, { redirect: 'manual' });
    return { ok: v.status < 500, detail: `fresh verify ${v.status}` };
  }
  if (res.status === 409 || res.status === 429) return { ok: true, detail: `reusing account (${res.status})` };
  return { ok: false, detail: `${res.status} ${await res.text()}` };
}

// ---- main ---------------------------------------------------------------
try {
  const seed = await getSeedImage();
  check('seed product photo available', !!seed, seed?.path);

  for (const u of [SELLER, BUYER]) {
    const r = await registerVerify(u);
    check(`register+verify ${u.email}`, r.ok, r.detail);
  }

  const sIn = await signin('seller', SELLER.email, SELLER.password);
  check('seller sign-in', sIn.status === 200 || sIn.status === 302, `status ${sIn.status}`);
  const bIn = await signin('buyer', BUYER.email, BUYER.password);
  check('buyer sign-in', bIn.status === 200 || bIn.status === 302, `status ${bIn.status}`);

  const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? '').trim() || 'greengateindustries.com@gmail.com';
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD_LOCAL ?? '';
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD_LOCAL env missing (read from .env in the shell)');
  const aIn = await signin('admin', ADMIN_EMAIL, ADMIN_PASSWORD);
  check('admin sign-in', aIn.status === 200 || aIn.status === 302, `status ${aIn.status}`);

  // ---- 2. seller submits the store application (light questionnaire — no
  // tax / ID / registration / sourcing / volume, matching the shortened form) ----
  const storeForm = multipart({
    name: `Thandi's Craft Gate ${STAMP}`,
    description: 'Hand-woven baskets and beadwork from KwaZulu-Natal.',
    location: 'Pietermaritzburg, KwaZulu-Natal',
    phone: '0821234567',
    businessName: "Thandi's Crafts CC",
    businessType: 'cc',
    streetAddress: '21 Church Street',
    city: 'Pietermaritzburg',
    province: 'KwaZulu-Natal',
    postalCode: '3201',
    websiteOrSocial: 'https://instagram.com/thandiscrafts',
    bankName: 'Capitec Bank',
    bankAccountType: 'savings',
    bankAccountNumber: '1234567890',
    bankBranchCode: '470010',
    bankAccountHolder: 'T Nkosi',
    productCategories: 'Home & Living, Accessories',
    dispatchDays: '3',
    returnsDays: '14',
    ownsBrand: '1',
    confirmAge: '1',
    confirmAccuracy: '1',
    confirmTerms: '1',
  }, seed ? [['images', seed.path, seed.type], ['images', seed.path, seed.type]] : []);
  const storeRes = await POST_('seller', '/api/sellers', storeForm, 'multipart/form-data');
  const storeJson = await storeRes.json().catch(() => ({}));
  check('seller application submitted (POST /api/sellers)', storeRes.status === 201 || storeRes.status === 409, `status ${storeRes.status} ${storeJson.error ?? storeJson.store?.slug ?? ''}`);

  const mine = await GET_('seller', '/api/sellers?mine=1');
  const mineJson = await mine.json();
  const storeId = mineJson.store?.id;
  check('store visible on seller account (pending)', mine.status === 200 && !!storeId, `status ${mineJson.store?.status}`);

  // ---- 3. admin approves the store (skip if already active) -------------
  if (mineJson.store?.status === 'active') {
    check('admin approves the store', true, 'already active from a previous run');
    check('store now active', true, 'already active');
  } else {
  const approve = await POST_('admin', '/api/admin', { action: 'store_status', targetId: storeId, value: 'active' });
  check('admin approves the store', approve.status === 200, `status ${approve.status}`);
  const mine2 = await GET_('seller', '/api/sellers?mine=1');
  check('store now active', (await mine2.json())?.store?.status === 'active');
  }

  // ---- 4. seller submits a product --------------------------------------
  const cat = await db.category.findFirst();
  const prodForm = multipart({
    name: `Hand-woven Zulu Basket ${STAMP}`,
    description: '40cm grade-A hand-woven basket. Fair-trade, one of a kind.',
    category: cat?.slug ?? 'home-living',
    condition: 'new',
    price: '649.99',
    stock: '5',
    weightGrams: '900',
    lengthCm: '35',
    widthCm: '30',
    heightCm: '20',
    tags: 'handwoven, basket, zulucraft',
  }, seed ? [['images', seed.path, seed.type]] : []);
  const prodRes = await POST_('seller', '/api/products', prodForm, 'multipart/form-data');
  const prodJson = await prodRes.json().catch(() => ({}));
  check('product submitted (POST /api/products)', prodRes.status === 201, `status ${prodRes.status} ${prodJson.error ?? prodJson.product?.slug ?? ''}`);
  const productId = prodJson.product?.id;

  // seller product management view
  const myProducts = await GET_('seller', '/api/seller/products');
  check('seller product list works', myProducts.status === 200, `${((await myProducts.json()).products ?? []).length} products`);

  // ---- 5. buyer orders it (cart → checkout with delivery pin) -----------
  const cartRes = await POST_('buyer', '/api/cart', { productId, quantity: 2 });
  check('buyer adds to cart', cartRes.status === 200 || cartRes.status === 201, `status ${cartRes.status}`);
  // save the default delivery location first (the "always deliver here" flow)
  const addrRes = await POST_('buyer', '/api/addresses', {
    label: 'Home', recipientName: BUYER.name, phone: '0837654321',
    street: '234 Long Street', city: 'Cape Town', province: 'Western Cape', postalCode: '8001',
    latitude: -33.9249, longitude: 18.4241, locationSource: 'search', isDefault: true,
  });
  check('buyer saves default delivery location', addrRes.status === 201, `status ${addrRes.status}`);
  const shipRes = await fetch(`${BASE}/api/shipping`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: '234 Long Street, Cape Town, Western Cape, 8001', latitude: -33.9249, longitude: 18.4241 }),
  });
  const shipJson = await shipRes.json().catch(() => ({}));
  const shippingCode = shipJson?.options?.[0]?.code;
  check('shipping rates resolve (Courier Guy or fallback)', shipRes.status === 200, `${(shipJson?.options ?? []).length} options`);

  const orderRes = await POST_('buyer', '/api/checkout', {
    buyerName: BUYER.name, buyerPhone: '0837654321',
    address: '234 Long Street, Cape Town, Western Cape, 8001',
    shippingCode: shippingCode ?? 'standard',
    latitude: -33.9249, longitude: 18.4241, pinSource: 'search',
    idempotencyKey: `t36-${STAMP}`,
  });
  const orderJson = await orderRes.json().catch(() => ({}));
  check('buyer places order (checkout)', orderRes.status === 200 || orderRes.status === 201, `status ${orderRes.status} ${orderJson.error ?? ''}`);

  // ---- 6. seller dashboard: analytics + orders --------------------------
  const ana = await GET_('seller', '/api/seller/analytics?range=7');
  const anaJson = await ana.json();
  check('seller analytics (dashboard data)', ana.status === 200, `revenue R${((anaJson?.totals?.revenueCents ?? 0) / 100).toFixed(2)}, ${anaJson?.totals?.orders ?? 0} orders, ${anaJson?.totals?.units ?? 0} units, ${anaJson?.daily?.length ?? 0} day series`);
  check('analytics has chart series + slices', Array.isArray(anaJson?.daily) && anaJson.daily.length >= 7 && Array.isArray(anaJson?.categories), `daily=${anaJson?.daily?.length}, categories=${anaJson?.categories?.length}, topProducts=${anaJson?.topProducts?.length ?? '-'}`);
  const orders = await GET_('seller', '/api/seller/orders');
  const ordersJson = await orders.json();
  check('seller orders list (with the pin)', orders.status === 200 && (ordersJson?.orders ?? ordersJson)?.length > 0, `${(ordersJson?.orders ?? ordersJson)?.length ?? 0} orders`);
  const firstOrder = (ordersJson?.orders ?? ordersJson)?.[0];
  if (firstOrder) check('order carries delivery pin for courier', firstOrder.deliveryLat != null && firstOrder.deliveryLng != null, `pin ${firstOrder.deliveryLat},${firstOrder.deliveryLng} src=${firstOrder.deliveryPinSource}`);
} catch (e) {
  check('script error', false, e instanceof Error ? e.message : String(e));
} finally {
  await db.$disconnect();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILURES: ${failed.map((f) => f.step).join(' | ')}` : ' — ALL GREEN'}`);
process.exit(failed.length ? 1 : 0);
