/**
 * E2E — regression harness for the checkout "items are no longer available"
 * fix (the device-agnostic dead-cart-row problem):
 *
 *   L1  cart POST guard        — adding an unavailable product is refused
 *   L2  cart GET truth-sync    — dead stored rows are deleted + reported via
 *                                 `removed`, over-stock quantities are clamped
 *   L3  checkout 409 backstop  — a row that dies in the race window (after the
 *                                 last cart view, before checkout) is dropped
 *                                 with a truthful message; the retry succeeds
 *   L4  golden path            — healthy cart → checkout 201 → cart empties
 *
 * Dead rows are injected straight into the database so each layer is tested
 * deterministically (no dependence on request ordering). Uses the real HTTP
 * APIs with cookie jars (NextAuth credentials flow).
 * Run: bun scripts/e2e-checkout-selfheal.mjs
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

const db = new PrismaClient();
const BASE = 'http://localhost:3000';
const STAMP = Date.now().toString(36);
const SELLER = { name: 'Thandi Nkosi', email: 't36seller.mv6v7zx4@example.com', password: 'GateKeeper!2026' };
const BUYER = { name: 'Sipho Dlamini', email: process.env.E2E_BUYER_EMAIL ?? 't36buyer.mv6v7zx4@example.com', password: 'GateKeeper!2026' };
const PHOTO = '/tmp/t36-basket.jpg'; // real web-sourced photo — passes the AI-image guard

const results = [];
function check(step, ok, extra = '') {
  results.push({ step, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${extra ? ` — ${extra}` : ''}`);
}

// ---- cookie-jar helpers (same pattern as e2e-seller-flow.mjs) ------------
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
async function signinVerified(who, email, password) {
  for (let i = 0; i < 4; i++) {
    const csrfRes = await GET_(who, '/api/auth/csrf');
    const { csrfToken } = await csrfRes.json();
    const form = new URLSearchParams({ csrfToken, email, password, redirect: 'false', json: 'true' });
    await POST_(who, '/api/auth/callback/credentials', form.toString(), 'application/x-www-form-urlencoded');
    const sess = await GET_(who, '/api/auth/session');
    const sessJson = await sess.json().catch(() => ({}));
    if (sessJson?.user?.email) return true;
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}
async function registerVerify(user) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(user),
  });
  if (res.status === 201) {
    const row = await db.authToken.findFirst({ where: { identifier: user.email, purpose: 'email_verify' }, orderBy: { expires: 'desc' } });
    if (!row) return { ok: false, detail: 'no verification token in db' };
    const v = await fetch(`${BASE}/api/auth/verify?token=${row.token}`, { redirect: 'manual' });
    return { ok: v.status < 500, detail: `fresh verify ${v.status}` };
  }
  if (res.status === 409 || res.status === 429) return { ok: true, detail: `reusing account (${res.status})` };
  return { ok: false, detail: `${res.status} ${await res.text()}` };
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
async function cartGet() {
  const res = await GET_('buyer', '/api/cart');
  const json = await res.json().catch(() => ({}));
  return { status: res.status, lines: json.lines ?? [], removed: json.removed ?? [] };
}
async function buyerCartRows() {
  const buyer = await db.user.findUnique({ where: { email: BUYER.email } });
  return db.cartItem.findMany({ where: { userId: buyer?.id ?? '' } });
}
async function checkout(key) {
  const res = await POST_('buyer', '/api/checkout', {
    buyerName: BUYER.name, buyerPhone: '0837654321',
    address: '234 Long Street, Cape Town, Western Cape, 8001',
    shippingCode: 'economy',
    latitude: -33.9249, longitude: 18.4241, pinSource: 'search',
    idempotencyKey: key,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

try {
  // ---- accounts -------------------------------------------------------------
  for (const u of [SELLER, BUYER]) {
    const r = await registerVerify(u);
    check(`register+verify ${u.email}`, r.ok, r.detail);
  }
  check('seller sign-in (session verified)', await signinVerified('seller', SELLER.email, SELLER.password));
  check('buyer sign-in (session verified)', await signinVerified('buyer', BUYER.email, BUYER.password));

  // ---- fresh live product -----------------------------------------------------
  const cat = await db.category.findFirst();
  const prodRes = await POST_('seller', '/api/products', multipart({
    name: `Self-Heal Regression D ${STAMP}`,
    description: 'Regression product for the checkout self-heal harness.',
    category: cat?.slug ?? 'home-living', condition: 'new',
    price: '149.99', stock: '5', weightGrams: '900', lengthCm: '35', widthCm: '30', heightCm: '20',
    tags: 'regression, e2e',
  }, [['images', PHOTO, 'image/jpeg']]), 'multipart/form-data');
  const prodJson = await prodRes.json().catch(() => ({}));
  const prodD = prodJson.product?.id;
  check('live product uploaded', prodRes.status === 201 && !!prodD, `status ${prodRes.status}`);

  // an unavailable product: any disabled/archived product works; reuse the
  // disabled one from an earlier run if present, else disable a fresh upload.
  let deadProduct = await db.product.findFirst({ where: { status: { not: 'approved' } }, select: { id: true, name: true } });
  if (!deadProduct) {
    const res2 = await POST_('seller', '/api/products', multipart({
      name: `Self-Heal Regression E ${STAMP}`,
      description: 'Will be disabled to become the dead row.',
      category: cat?.slug ?? 'home-living', condition: 'new',
      price: '99.99', stock: '5', weightGrams: '900', lengthCm: '35', widthCm: '30', heightCm: '20',
      tags: 'regression, e2e',
    }, [['images', PHOTO, 'image/jpeg']]), 'multipart/form-data');
    const json2 = await res2.json().catch(() => ({}));
    deadProduct = json2.product?.id
      ? await db.product.update({ where: { id: json2.product.id }, data: { status: 'disabled' }, select: { id: true, name: true } })
      : null;
  }
  check('unavailable product available for tests', !!deadProduct, deadProduct?.name ?? 'none');

  const buyer = await db.user.findUnique({ where: { email: BUYER.email } });

  // ---- L1: cart POST guard ----------------------------------------------------
  const guard = await POST_('buyer', '/api/cart', { productId: deadProduct.id, quantity: 1 });
  check('L1 cart POST refuses unavailable product (404)', guard.status === 404, `status ${guard.status}`);

  // ---- L2a: truth-sync deletes a dead stored row + reports it -------------------
  await db.cartItem.create({ data: { userId: buyer.id, productId: deadProduct.id, quantity: 1 } });
  const sync = await cartGet();
  check('L2 dead row not shown in cart lines', !sync.lines.some((l) => l.productId === deadProduct.id), `${sync.lines.length} live lines`);
  check('L2 `removed` names the dropped item', sync.removed.includes(deadProduct.name), JSON.stringify(sync.removed));
  const rowsAfterSync = await buyerCartRows();
  check('L2 dead row deleted from stored cart', !rowsAfterSync.some((r) => r.productId === deadProduct.id), `${rowsAfterSync.length} rows left`);

  // ---- L2b: over-stock quantity clamped to real stock ---------------------------
  await db.cartItem.create({ data: { userId: buyer.id, productId: prodD, quantity: 99 } });
  const clamp = await cartGet();
  const clampedLine = clamp.lines.find((l) => l.productId === prodD);
  check('L2 over-stock quantity clamped to stock (5)', clampedLine?.quantity === 5, `qty ${clampedLine?.quantity}`);
  const rowsAfterClamp = await buyerCartRows();
  const storedQty = rowsAfterClamp.find((r) => r.productId === prodD)?.quantity;
  check('L2 clamp persisted to the stored cart', storedQty === 5, `stored qty ${storedQty}`);
  // clean up for the next phase
  await db.cartItem.deleteMany({ where: { userId: buyer.id } });

  // ---- L3: checkout 409 backstop (dead row present, no cart view in between) ----
  await db.cartItem.create({ data: { userId: buyer.id, productId: deadProduct.id, quantity: 1 } });
  await db.cartItem.create({ data: { userId: buyer.id, productId: prodD, quantity: 1 } });
  const co1 = await checkout(`tsh-${STAMP}-1`);
  const msg = String(co1.json.error ?? '');
  check('L3 checkout returns 409 in the race window', co1.status === 409, `status ${co1.status}`);
  check('L3 message names the removed item', msg.includes(deadProduct.name) && msg.includes('removed from your cart'), msg.slice(0, 120));
  const rowsAfter409 = await buyerCartRows();
  check('L3 dead row deleted by checkout', !rowsAfter409.some((r) => r.productId === deadProduct.id), `${rowsAfter409.length} rows left`);
  check('L3 healthy row kept', rowsAfter409.some((r) => r.productId === prodD));

  // ---- L4: golden path — the very next attempt succeeds -------------------------
  const co2 = await checkout(`tsh-${STAMP}-2`);
  check('L4 retry checkout succeeds (self-healed)', [200, 201].includes(co2.status), `status ${co2.status} ${co2.json.error ?? ''}`);
  const rowsAfterSuccess = await buyerCartRows();
  check('L4 cart empties after success', rowsAfterSuccess.length === 0, `${rowsAfterSuccess.length} rows left`);
  // duplicate submit protection (idempotent replay returns the original, never a second order)
  const keyOrdersBefore = await db.order.count({ where: { idempotencyKey: { startsWith: `tsh-${STAMP}-2:` } } });
  const co3 = await checkout(`tsh-${STAMP}-2`);
  const keyOrdersAfter = await db.order.count({ where: { idempotencyKey: { startsWith: `tsh-${STAMP}-2:` } } });
  check('L4 idempotency key cannot double-order', [200, 201, 429].includes(co3.status) && keyOrdersBefore === keyOrdersAfter, `orders ${keyOrdersBefore}→${keyOrdersAfter}, status ${co3.status}`);
} catch (e) {
  check('script error', false, e instanceof Error ? e.message : String(e));
} finally {
  await db.$disconnect();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILURES: ${failed.map((f) => f.step).join(' | ')}` : ' — ALL GREEN'}`);
process.exit(failed.length ? 1 : 0);
