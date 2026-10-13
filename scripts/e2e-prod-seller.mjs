/**
 * Task 36 — PRODUCTION seller-flow verification on https://greengatemarket.store
 * register → sign in → submit store application → admin approval → analytics.
 * No local DB needed (sign-in does not require email verification by design).
 * Run: ADMIN_EMAIL=... ADMIN_PASSWORD=... bun scripts/e2e-prod-seller.mjs
 */
const BASE = 'https://greengatemarket.store';
const STAMP = Date.now().toString(36);
const SELLER = { name: 'Prod Test Seller', email: `t36seller.prod.${STAMP}@example.com`, password: 'GateKeeper!2026' };

const results = [];
function check(step, ok, extra = '') {
  results.push({ step, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${extra ? ` — ${extra}` : ''}`);
}

const jar = [];
function absorb(res) {
  const cs = res.headers.getSetCookie?.() ?? [];
  for (const c of cs) {
    const k = c.split('=')[0];
    const i = jar.findIndex((x) => x.startsWith(`${k}=`));
    if (i >= 0) jar[i] = c; else jar.push(c);
  }
}
const ch = () => jar.map((c) => `${c.split('=')[0]}=${c.split('=')[1]?.split(';')[0]}`).join('; ');
async function GET_(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: ch() }, redirect: 'manual' });
  absorb(res);
  return res;
}
async function POST_(path, body, contentType) {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const isStr = typeof body === 'string';
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { cookie: ch(), ...(isForm ? {} : { 'content-type': contentType ?? (isStr ? 'text/plain' : 'application/json') }) },
    body: isForm || isStr ? body : JSON.stringify(body),
    redirect: 'manual',
  });
  absorb(res);
  return res;
}
async function signin(email, password) {
  const csrfRes = await GET_('/api/auth/csrf');
  const { csrfToken } = await csrfRes.json();
  const form = new URLSearchParams({ csrfToken, email, password, redirect: 'false', json: 'true' });
  return POST_('/api/auth/callback/credentials', form.toString(), 'application/x-www-form-urlencoded');
}
function multipart(fields, files = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  for (const [k, path, type] of files) fd.append(k, new Blob([readFileSync(path)], { type }), path.split('/').pop());
  return fd;
}
import { readFileSync } from 'node:fs';

try {
  // ---- health first ------------------------------------------------------
  const health = await fetch(`${BASE}/api/health`);
  const healthJson = await health.json().catch(() => ({}));
  check('prod health', health.status === 200, `db=${healthJson?.checks?.database?.status ?? healthJson?.database?.status ?? '?'} delivery=${healthJson?.checks?.delivery?.status ?? '?'}`);

  // ---- register + sign in ------------------------------------------------
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(SELLER),
  });
  check('register on prod', reg.status === 201 || reg.status === 409 || reg.status === 429, `status ${reg.status}`);
  const sIn = await signin(SELLER.email, SELLER.password);
  check('seller sign-in on prod', sIn.status === 200 || sIn.status === 302, `status ${sIn.status}`);
  const me = await GET_('/api/auth/me');
  const meJson = await me.json();
  check('session works (me)', me.status === 200 && !!meJson?.user?.id, meJson?.user?.email ?? '');

  // ---- submit the store application (real photo) -------------------------
  const photo = '/tmp/t36-basket.jpg';
  const storeForm = multipart({
    name: `Prod Verification Store ${STAMP}`,
    description: 'Temporary store used to verify the Green Gate seller submission flow end-to-end.',
    location: 'Bloemfontein, Free State',
    phone: '0825550000',
    businessType: 'individual',
    idNumber: '9001015800085',
    streetAddress: '125 Nelson Mandela Drive',
    city: 'Bloemfontein',
    province: 'Free State',
    postalCode: '9301',
    bankName: 'FNB',
    bankAccountType: 'cheque',
    bankAccountNumber: '62123456789',
    bankBranchCode: '230565',
    bankAccountHolder: 'Prod Test Seller',
    productCategories: 'Home & Living',
    sourcing: 'own_make',
    monthlyVolume: '1-20',
    dispatchDays: '2',
    returnsDays: '10',
    ownsBrand: '1',
    confirmAge: '1',
    confirmAccuracy: '1',
    confirmTerms: '1',
  }, [['images', photo, 'image/jpeg'], ['images', photo, 'image/jpeg']]);
  const storeRes = await POST_('/api/sellers', storeForm);
  const storeJson = await storeRes.json().catch(() => ({}));
  check('seller application submitted on prod', storeRes.status === 201 || storeRes.status === 409, `status ${storeRes.status} ${storeJson.error ?? storeJson.store?.slug ?? ''}`);

  const mine = await GET_('/api/sellers?mine=1');
  const mineJson = await mine.json();
  const storeId = mineJson.store?.id;
  check('store visible on prod seller account', mine.status === 200 && !!storeId, `status ${mineJson.store?.status}`);

  // ---- admin approves, verifies analytics access, then declines ---------
  const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? '').trim();
  const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD ?? '').trim();
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error('ADMIN_EMAIL/ADMIN_PASSWORD env required');
  const aIn = await signin(ADMIN_EMAIL, ADMIN_PASSWORD);
  check('admin sign-in on prod', aIn.status === 200 || aIn.status === 302, `status ${aIn.status}`);

  if (mineJson.store?.status === 'active') {
    check('admin approves store on prod', true, 'already active');
  } else {
    const approve = await POST_('/api/admin', { action: 'store_status', targetId: storeId, value: 'active' });
    check('admin approves store on prod', approve.status === 200, `status ${approve.status}`);
  }
  const mine2 = await GET_('/api/sellers?mine=1');
  check('store active on prod', (await mine2.json())?.store?.status === 'active');

  // seller analytics (dashboard data source) — as the seller again
  await signin(SELLER.email, SELLER.password);
  const ana = await GET_('/api/seller/analytics?range=30');
  const anaJson = await ana.json();
  check('seller dashboard analytics on prod', ana.status === 200 && Array.isArray(anaJson?.daily) && anaJson.daily.length >= 7, `daily=${anaJson?.daily?.length}, revenueCents=${anaJson?.totals?.revenueCents ?? '-'}`);
  const myProducts = await GET_('/api/seller/products');
  check('seller product management endpoint on prod', myProducts.status === 200, `status ${myProducts.status}`);

  // ---- cleanup: decline the verification store (never public) -----------
  await signin(ADMIN_EMAIL, ADMIN_PASSWORD);
  const decline = await POST_('/api/admin', { action: 'store_status', targetId: storeId, value: 'declined' });
  check('cleanup: verification store declined (not public)', decline.status === 200, `status ${decline.status}`);
} catch (e) {
  check('script error', false, e instanceof Error ? e.message : String(e));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILURES: ${failed.map((f) => f.step).join(' | ')}` : ' — ALL GREEN'}`);
process.exit(failed.length ? 1 : 0);
