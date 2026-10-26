import { NextRequest } from 'next/server';
import { db, IS_POSTGRES } from '@/lib/db';
import { requireUser, authErrorResponse, AuthError } from '@/lib/auth';
import { storeSlug } from '@/lib/password';
import { guardImage } from '@/lib/ai-image-guard';
import { audit } from '@/lib/audit';
import { rateLimitShared, clientIp, tooManyRequests } from '@/lib/rate-limit';
import { bootstrap } from '@/lib/bootstrap';
import { encryptSecret, secretIsSet } from '@/lib/secret-box';
import { maybeUploadDataUrl } from '@/lib/storage';
import { storeImageVersion } from '@/lib/store-images';
import { requireSellerTools, sellingStoreWhere, storeAccess, storeCanSell } from '@/lib/subscription';
import { yocoKeyLooksValid, yocoKeyUsable } from '@/lib/yoco';
import { sellerPaymentStatus } from '@/lib/order-payment-options';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Public store directory. ?mine=1 returns the caller's own store; ?slug=<slug>
 *  returns ONE public store by slug (the store page must resolve at any
 *  directory size, not just within the first 200 rows). */
export async function GET(req: NextRequest) {
  try {
    await bootstrap();
    const slugParam = new URL(req.url).searchParams.get('slug')?.trim();
    if (slugParam) {
      const store = await db.store.findUnique({
        where: { slug: slugParam },
        select: {
          id: true, slug: true, name: true, description: true, logoData: true, bannerData: true, location: true, createdAt: true, status: true,
          ratingSum: true, ratingCount: true, billingExempt: true, accessUntil: true,
          _count: { select: { products: { where: { status: 'approved' } } } },
        },
      });
      // Only stores that may sell have a public profile page — the same rule
      // the directory and the catalogue apply (active + subscription running).
      if (!store || !storeCanSell(store)) {
        return Response.json({ store: null }, { status: 404 });
      }
      return Response.json({
        store: {
          id: store.id, slug: store.slug, name: store.name, description: store.description,
          // Images by reference (edge-cached files), not inline base64.
          logoData: store.logoData ? `/api/images/store/${store.id}?v=${storeImageVersion(store.logoData)}` : null,
          bannerData: store.bannerData ? `/api/images/store/${store.id}?kind=banner&v=${storeImageVersion(store.bannerData)}` : null,
          location: store.location, createdAt: store.createdAt.toISOString(), productCount: store._count.products,
          ratingAvg: store.ratingCount > 0 ? Math.round((store.ratingSum / store.ratingCount) * 10) / 10 : null,
          ratingCount: store.ratingCount,
        },
      });
    }
    // Store search — the site search shows matching STORES next to products
    // (before, a store could only be found through its products, so a store
    // with no matching listing was unfindable). Every word must match the
    // store's name, description, town or slug; only active stores.
    const qParam = new URL(req.url).searchParams.get('q')?.trim().slice(0, 100);
    if (qParam) {
      const ci = IS_POSTGRES ? { mode: 'insensitive' as const } : {};
      const words = qParam.split(/\s+/).filter(Boolean).slice(0, 6);
      const found = await db.store.findMany({
        where: {
          ...sellingStoreWhere(),
          AND: words.map((w) => ({
            OR: [
              { name: { contains: w, ...ci } },
              { description: { contains: w, ...ci } },
              { location: { contains: w, ...ci } },
              { slug: { contains: w.toLowerCase() } },
            ],
          })),
        },
        orderBy: [{ ratingCount: 'desc' }, { createdAt: 'desc' }],
        take: 12,
        select: {
          id: true, slug: true, name: true, description: true, logoData: true, location: true,
          ratingSum: true, ratingCount: true,
          _count: { select: { products: { where: { status: 'approved' } } } },
        },
      });
      return Response.json({
        stores: found.map((s) => ({
          id: s.id, slug: s.slug, name: s.name, description: s.description, location: s.location,
          logoData: s.logoData ? `/api/images/store/${s.id}?v=${storeImageVersion(s.logoData)}` : null,
          productCount: s._count.products,
          ratingAvg: s.ratingCount > 0 ? Math.round((s.ratingSum / s.ratingCount) * 10) / 10 : null,
          ratingCount: s.ratingCount,
        })),
      }, { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' } });
    }
    if (new URL(req.url).searchParams.get('mine') === '1') {
      const session = await requireUser();
      const mine = await db.store.findUnique({ where: { userId: session.user.id } });
      // Never return any processor secret to any client — expose only
      // whether each one is connected (for the dashboard UI state).
      const { yocoSecretKey, payfastMerchantKeyEnc, payfastPassphraseEnc, ozowPrivateKeyEnc, ozowApiKeyEnc, ...safeStore } = mine ?? { yocoSecretKey: undefined };
      return Response.json({
        store: mine
          ? {
              ...safeStore,
              // *KeySet = something is SAVED (placeholders / remove boxes);
              // paymentStatus = what buyers are REALLY offered + what to fix.
              yocoKeySet: Boolean(yocoSecretKey),
              payfastKeySet: Boolean(mine.payfastMerchantId && secretIsSet(payfastMerchantKeyEnc)),
              ozowKeySet: Boolean(mine.ozowSiteCode && secretIsSet(ozowPrivateKeyEnc)),
              paymentStatus: sellerPaymentStatus(mine),
              // Subscription state for the dashboard (trial / paid / free /
              // expired — expired locks the seller tools).
              access: storeAccess(mine),
            }
          : null,
      });
    }
    // Capped at the 200 newest active stores per page so this PUBLIC directory
    // (which carries base64 logo/banner data per row) stays bounded at
    // marketplace scale; `?offset=` pages deeper and `total`/`hasMore` ride
    // along. Each store carries its denormalised rating.
    const DIRECTORY_LIMIT = 200;
    const offset = Math.max(0, Math.floor(Number(new URL(req.url).searchParams.get('offset')) || 0));
    const [stores, total] = await Promise.all([
      db.store.findMany({
        where: sellingStoreWhere(),
        orderBy: { createdAt: 'desc' },
        take: DIRECTORY_LIMIT,
        skip: offset,
        select: {
          id: true, slug: true, name: true, description: true, logoData: true, bannerData: true, location: true, createdAt: true,
          ratingSum: true, ratingCount: true,
          _count: { select: { products: { where: { status: 'approved' } } } },
        },
      }),
      db.store.count({ where: sellingStoreWhere() }),
    ]);
    return Response.json({
      stores: stores.map((s) => ({
        id: s.id, slug: s.slug, name: s.name, description: s.description,
        // Images by reference (edge-cached files), not inline base64 — the
        // directory used to ship every logo/banner in full on each visit.
        logoData: s.logoData ? `/api/images/store/${s.id}?v=${storeImageVersion(s.logoData)}` : null,
        bannerData: s.bannerData ? `/api/images/store/${s.id}?kind=banner&v=${storeImageVersion(s.bannerData)}` : null,
        location: s.location, createdAt: s.createdAt.toISOString(), productCount: s._count.products,
        ratingAvg: s.ratingCount > 0 ? Math.round((s.ratingSum / s.ratingCount) * 10) / 10 : null,
        ratingCount: s.ratingCount,
      })),
      total,
      hasMore: total > offset + stores.length,
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('sellers GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load stores.' }, { status: 500 });
  }
}

/**
 * Create the signed-in user's store. Upgrades the account to SELLER.
 * Optional logo/banner images go through the same AI guard as products.
 */
export async function POST(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireUser();

    const existing = await db.store.findUnique({ where: { userId: session.user.id } });
    if (existing) return Response.json({ error: 'You already have a store.' }, { status: 409 });

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      // Wrong Content-Type or malformed multipart body — say exactly that
      // instead of a generic 500 (the caller can actually fix it).
      return Response.json({ error: 'Send the application as multipart/form-data.' }, { status: 400 });
    }
    const name = String(form.get('name') ?? '').trim();
    const description = String(form.get('description') ?? '').trim() || null;
    const location = String(form.get('location') ?? '').trim();
    const phone = String(form.get('phone') ?? '').trim();

    // ---- Seller application questionnaire (multi-step form data) ----
    const str = (key: string) => String(form.get(key) ?? '').trim();
    const businessName = str('businessName') || null;
    const businessType = str('businessType');
    const registrationNumber = str('registrationNumber') || null;
    const taxNumber = str('taxNumber') || null;
    // Tax and ID numbers are no longer collected by the application form —
    // kept here only so legacy payloads still store what they send.
    const idNumber = str('idNumber') || null;
    const streetAddress = str('streetAddress');
    const city = str('city');
    const province = str('province');
    const postalCode = str('postalCode');
    const websiteOrSocial = str('websiteOrSocial') || null;
    const bankName = str('bankName');
    const bankAccountType = str('bankAccountType');
    const bankAccountNumber = str('bankAccountNumber');
    const bankBranchCode = str('bankBranchCode');
    const bankAccountHolder = str('bankAccountHolder');
    const productCategories = str('productCategories') || null;
    const sourcing = str('sourcing') || null;
    const monthlyVolume = str('monthlyVolume') || null;
    const dispatchDays = Number(str('dispatchDays'));
    const returnsDays = Number(str('returnsDays'));
    const ownsBrand = str('ownsBrand') === '1';
    const confirmAge = str('confirmAge') === '1';
    const confirmAccuracy = str('confirmAccuracy') === '1';
    const confirmTerms = str('confirmTerms') === '1';

    const BUSINESS_TYPES = ['individual', 'sole_proprietor', 'partnership', 'pty', 'cc', 'other'];
    const PROVINCES = [
      'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo',
      'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape', 'Other',
    ];
    const SOURCING = ['own_make', 'wholesale', 'vintage', 'mixed'];
    const VOLUMES = ['1-20', '21-50', '51-200', '201-500', '500+'];
    const ACCOUNT_TYPES = ['cheque', 'savings', 'transmission'];

    const errors: string[] = [];
    if (name.length < 2 || name.length > 60) errors.push('Store name must be 2–60 characters');
    if (location.length < 2) errors.push('Enter your location (city/suburb)');
    if (phone.replace(/\D/g, '').length < 9) errors.push('Enter a valid contact number');

    // Business details
    if (!BUSINESS_TYPES.includes(businessType)) errors.push('Select your business type');
    if (businessName && businessName.length > 120) errors.push('Registered business name is too long');
    // Tax, ID and registration numbers are never required — the application
    // stays light; business verification happens after approval, if needed.

    // Address
    if (streetAddress.length < 4) errors.push('Enter the street address for collections/returns');
    if (city.length < 2) errors.push('Enter your city');
    if (!PROVINCES.includes(province)) errors.push('Select your province');
    if (!/^\d{4}$/.test(postalCode)) errors.push('Postal code must be 4 digits');

    // Banking
    if (bankName.length < 2) errors.push('Enter your bank name');
    if (!ACCOUNT_TYPES.includes(bankAccountType)) errors.push('Select your account type');
    if (!/^\d{4,17}$/.test(bankAccountNumber)) errors.push('Account number must be 4–17 digits');
    if (!/^\d{4,6}$/.test(bankBranchCode)) errors.push('Branch code must be 4–6 digits');
    if (bankAccountHolder.length < 2) errors.push('Enter the bank account holder name');

    // Operations — sourcing and volume are optional context, validated only
    // when the seller volunteers them.
    if (sourcing && !SOURCING.includes(sourcing)) errors.push('Select where your products come from');
    if (monthlyVolume && !VOLUMES.includes(monthlyVolume)) errors.push('Select your expected monthly volume');
    if (!Number.isFinite(dispatchDays) || dispatchDays < 1 || dispatchDays > 30) errors.push('Dispatch time must be 1–30 days');
    if (!Number.isFinite(returnsDays) || returnsDays < 0 || returnsDays > 90) errors.push('Return window must be 0–90 days');

    // Declarations
    if (!confirmAge) errors.push('Confirm that you are 18 or older');
    if (!confirmAccuracy) errors.push('Confirm that your application information is accurate');
    if (!confirmTerms) errors.push('Accept the Green Gate seller terms and privacy policy');

    if (errors.length > 0) return Response.json({ error: errors.join('. ') }, { status: 400 });

    // Rate limit the EXPENSIVE path only (image forensics + DB transaction),
    // placed after validation so a user fixing typos never burns their quota
    // on 400s — and infrastructure failures can never lock real sellers out.
    const rl = await rateLimitShared(`store-create:${session.user.id}`, 3, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const imageFiles = form.getAll('images').filter((f): f is File => f instanceof File && f.size > 0);
    // Object storage (additive): with an S3-compatible bucket configured the
    // logo/banner is uploaded and its https URL stored; otherwise the data
    // URL passes through unchanged, exactly as before.
    const logoData: string | null = imageFiles[0] ? await maybeUploadDataUrl(await guardedDataUrl(imageFiles[0]), 'stores') : null;
    const bannerData: string | null = imageFiles[1] ? await maybeUploadDataUrl(await guardedDataUrl(imageFiles[1]), 'stores') : null;
    if (logoData === 'REJECTED' || bannerData === 'REJECTED') {
      return Response.json({ error: 'Store images rejected: AI-generated images are not permitted. Upload real photos.' }, { status: 422 });
    }

    const store = await db.$transaction(async (tx) => {
      const created = await tx.store.create({
        data: {
          userId: session.user.id, slug: storeSlug(name), name, description, location, phone, logoData, bannerData,
          // Applications enter review: the store goes live only when the
          // marketplace administration accepts it (admin console / admin view).
          status: 'pending',
          businessName, businessType, registrationNumber, taxNumber, idNumber,
          streetAddress, city, province, postalCode, websiteOrSocial,
          bankName, bankAccountType, bankAccountNumber, bankBranchCode, bankAccountHolder,
          productCategories, sourcing, monthlyVolume,
          dispatchDays: Math.round(dispatchDays), returnsDays: Math.round(returnsDays),
          ownsBrand, confirmAge, confirmAccuracy, confirmTerms,
          applicationAt: new Date(),
        },
      });
      await tx.user.update({ where: { id: session.user.id }, data: { role: session.user.role === 'ADMIN' ? 'ADMIN' : 'SELLER' } });
      return created;
    });

    await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'store_created', target: store.slug, detail: `${name} · application completed`, ip: clientIp(req) });
    const { sendStoreWelcome } = await import('@/lib/email');
    void sendStoreWelcome({ to: session.user.email, storeName: name, ownerName: session.user.name ?? 'Seller' });

    return Response.json({ ok: true, store: { id: store.id, slug: store.slug, name: store.name } }, { status: 201 });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    const detail = e instanceof Error ? e.message.slice(0, 300) : 'unknown error';
    console.error('sellers POST error:', detail);
    // Operational visibility: failed applications must be diagnosable from
    // the admin console's audit view (what is failing, and why).
    await audit({ action: 'seller_application_failed', detail });
    const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
    if (code === 'P2003') {
      // Cross-instance storage divergence: this server does not hold the
      // signed-in account's row (ephemeral /tmp databases per instance).
      // Never fake success — say exactly what a retry can and cannot do.
      return Response.json(
        { error: 'Your application could not be saved: the marketplace is running in temporary-storage mode, so requests land on different servers. Connect a hosted database (DATABASE_URL) to enable applications. Please contact support if you need help.' },
        { status: 503 },
      );
    }
    return Response.json({ error: 'Could not create the store.' }, { status: 500 });
  }
}

const STORE_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
const STORE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** Server-side magic-byte sniffing — client MIME types are never trusted (spec #15). */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 4).toString('hex') === '89504e47') return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Guard a store logo/banner upload: magic-byte type check + AI-imagery
 * forensics, then a bounded normalize — the result is re-encoded through
 * sharp to at most 1280px on the long edge (aspect preserved, never
 * enlarged) as JPEG q85 (~100-300KB). Without this, an 8MB upload lands in
 * the database raw (~10.7MB base64) and the PUBLIC directory response
 * ships it for every store row. Returns the image as a data URL, or
 * 'REJECTED' (same contract as before — callers unchanged).
 */
async function guardedDataUrl(file: File): Promise<string | 'REJECTED'> {
  if (file.size > STORE_IMAGE_MAX_BYTES) return 'REJECTED';
  const buf = Buffer.from(await file.arrayBuffer());
  const mime = sniffImageMime(buf);
  if (!mime || !STORE_IMAGE_MIME.includes(mime as (typeof STORE_IMAGE_MIME)[number])) return 'REJECTED';
  const guard = await guardImage(buf, mime);
  if (!guard.allowed) return 'REJECTED';
  try {
    const { default: sharp } = await import('sharp');
    const normalized = await sharp(buf)
      .rotate() // honour EXIF orientation before resizing
      .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      // JPEG has no transparency — put transparent logos on white, not black.
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer();
    return `data:image/jpeg;base64,${normalized.toString('base64')}`;
  } catch (e) {
    console.error('store image normalize failed:', e instanceof Error ? e.message : e);
    return 'REJECTED';
  }
}

/**
 * Save the seller's own payment-processor details. Sellers choose which
 * processor they accept (PayFast, Ozow, Yoco, Mastercard, bank transfer…),
 * are linked to each platform to create their own account, and paste their
 * keys or hosted payment-page link. Buyers then see a "Pay online"
 * option for this store at checkout; the order remains awaiting_payment
 * until the seller confirms receipt — exactly like bank transfer, but with a
 * one-click payment page. Secrets are NEVER accepted here: only a public
 * payment-page URL, so there is nothing sensitive to leak.
 */
export async function PATCH(req: NextRequest) {
  try {
    await bootstrap();
    // Payment details are saved by the store's OWNER. Sellers qualify by role
    // and admins may operate their own store too — the same rule every other
    // seller endpoint applies (this handler was the only one requiring exactly
    // SELLER, which locked admin-run stores out of saving payment details with
    // a 403 "you do not have permission"). Legacy accounts that own a store
    // but predate the role upgrade self-heal here, so an existing seller can
    // never be locked out of their own payment settings.
    const session = await requireUser();
    const dbRole = (await db.user.findUnique({ where: { id: session.user.id }, select: { role: true } }))?.role;
    if (dbRole !== 'SELLER' && dbRole !== 'ADMIN') {
      const ownedStore = await db.store.findUnique({ where: { userId: session.user.id }, select: { id: true } });
      if (ownedStore) {
        await db.user.update({ where: { id: session.user.id }, data: { role: 'SELLER' } });
      } else {
        throw new AuthError('You do not have permission to perform this action', 403);
      }
    }
    const rl = await rateLimitShared(`seller-payment:${session.user.id}:${clientIp(req)}`, 20, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    // Store settings need a running subscription (billing and orders stay open).
    await requireSellerTools(session.user.id);

    const body = (await readJsonObject(req)) as { payoutProvider?: string; payoutLink?: string; payoutNote?: string; yocoSecretKey?: string; clearYocoKey?: boolean; bankName?: string; bankAccountType?: string; bankAccountNumber?: string; bankBranchCode?: string; bankAccountHolder?: string; payfastMerchantId?: string; payfastMerchantKey?: string; payfastPassphrase?: string; clearPayfast?: boolean; ozowSiteCode?: string; ozowPrivateKey?: string; ozowApiKey?: string; clearOzow?: boolean; } | null;
    if (!body) return invalidJsonBody();
    // SnapScan and Stripe were removed at the owner's request — no longer
    // selectable. Legacy stores holding those values keep rendering through
    // the label fallbacks until the seller picks a new processor.
    const ALLOWED = ['bank_transfer', 'payfast', 'ozow', 'yoco', 'mastercard', 'other'];
    const provider = String(body.payoutProvider ?? '').trim();
    const link = String(body.payoutLink ?? '').trim();
    const note = String(body.payoutNote ?? '').trim();

    if (provider && !ALLOWED.includes(provider)) {
      return Response.json({ error: 'Unknown payment processor.' }, { status: 400 });
    }
    // The hosted payment-page link is only shown for (and used by) the 'other'
    // choice — and for bank transfer, where the field is visible too. A stale
    // legacy link left over on a store must never block an in-app credential
    // save for PayFast/Ozow/Yoco, where the field is hidden and the link is
    // dormant; it is simply carried through unchanged.
    const linkUsedByChoice = !provider || provider === 'other';
    if (link && linkUsedByChoice && !/^https:\/\/[^\s]{4,300}$/i.test(link)) {
      return Response.json({ error: 'The payment link must be a secure https:// web address.' }, { status: 400 });
    }
    if (note.length > 200) {
      return Response.json({ error: 'Keep the payment note under 200 characters.' }, { status: 400 });
    }

    // In-system card payments (Yoco Checkout API — Mastercard & Visa).
    // The key is validated, AES-256-GCM encrypted and stored; it is never
    // returned by any API. Absent field = leave the stored key unchanged so
    // saving other payment details never wipes a connected key.
    const CARD_PROVIDERS = ['yoco', 'mastercard'];
    let yocoUpdate: { yocoSecretKey: string | null } | undefined;
    let yocoAuditNote: string | undefined;
    if (body.clearYocoKey === true) {
      yocoUpdate = { yocoSecretKey: null };
      yocoAuditNote = 'yoco_key_cleared';
    } else if (typeof body.yocoSecretKey === 'string' && body.yocoSecretKey.trim()) {
      const rawKey = body.yocoSecretKey.trim();
      if (!CARD_PROVIDERS.includes(provider || 'yoco')) {
        return Response.json({ error: 'Choose Yoco (or Mastercard cards via Yoco) as the processor before saving a Yoco key.' }, { status: 400 });
      }
      if (!yocoKeyLooksValid(rawKey)) {
        return Response.json({ error: 'That does not look like a Yoco secret key — it should start with sk_live_ or sk_test_. Find it in the Yoco Business Portal under Sell Online → Payment Gateway.' }, { status: 400 });
      }
      if (!yocoKeyUsable(rawKey)) {
        return Response.json({ error: 'That is a Yoco TEST key — test payments move no money, so the live marketplace only accepts your LIVE secret key (it starts with sk_live_). Find it in the Yoco Business Portal under Sell Online → Payment Gateway.' }, { status: 400 });
      }
      const box = encryptSecret(rawKey);
      if (!box) return Response.json({ error: 'Could not secure the key. Please try again.' }, { status: 500 });
      yocoUpdate = { yocoSecretKey: box };
      yocoAuditNote = 'yoco_key_set';
    }

    // Seller-owned PayFast account for IN-APP Onsite payments (card + SiD
    // instant EFT inside a lightbox on our page). Merchant id/key appear in
    // every PayFast form (public); the passphrase is the real secret — both
    // are AES-256-GCM encrypted at rest and never returned by any API.
    // Secrets already on file — re-saving a processor without retyping a
    // secret keeps the saved one (it used to wipe the PayFast passphrase).
    const saved = await db.store.findUnique({
      where: { userId: session.user.id },
      select: { payfastMerchantId: true, payfastMerchantKeyEnc: true, payfastPassphraseEnc: true, ozowSiteCode: true, ozowPrivateKeyEnc: true, ozowApiKeyEnc: true },
    });
    let payfastUpdate: { payfastMerchantId?: string | null; payfastMerchantKeyEnc?: string | null; payfastPassphraseEnc?: string | null } | undefined;
    let payfastAuditNote: string | undefined;
    const payfastPassIn = typeof body.payfastPassphrase === 'string' ? body.payfastPassphrase.trim() : '';
    if (payfastPassIn && payfastPassIn.length < 4) {
      return Response.json({ error: 'The PayFast passphrase must be at least 4 characters — use exactly the passphrase set in PayFast → Settings → Developer Settings.' }, { status: 400 });
    }
    if (body.clearPayfast === true) {
      payfastUpdate = { payfastMerchantId: null, payfastMerchantKeyEnc: null, payfastPassphraseEnc: null };
      payfastAuditNote = 'payfast_cleared';
    } else if (typeof body.payfastMerchantId === 'string' && body.payfastMerchantId.trim() && typeof body.payfastMerchantKey === 'string' && body.payfastMerchantKey.trim()) {
      if (provider !== 'payfast') {
        return Response.json({ error: 'Choose PayFast as the processor before saving PayFast merchant details.' }, { status: 400 });
      }
      const merchantId = body.payfastMerchantId.trim();
      const merchantKey = body.payfastMerchantKey.trim();
      if (!/^\d{5,20}$/.test(merchantId)) {
        return Response.json({ error: 'PayFast merchant IDs are numeric — copy the Merchant ID exactly as shown in your PayFast dashboard (Settings → Developer Settings).' }, { status: 400 });
      }
      if (merchantKey.length < 6 || merchantKey.length > 64) {
        return Response.json({ error: 'That does not look like a PayFast merchant key — copy the Merchant Key exactly as shown in your PayFast dashboard (Settings → Developer Settings).' }, { status: 400 });
      }
      // The passphrase is REQUIRED: without it no PayFast payment can be
      // verified, so buyers would never be offered PayFast.
      const savedPassBox = !payfastPassIn && secretIsSet(saved?.payfastPassphraseEnc) ? saved?.payfastPassphraseEnc ?? null : null;
      if (!payfastPassIn && !savedPassBox) {
        return Response.json({ error: 'The PayFast passphrase is required — without it payments cannot be verified, so buyers would not be offered PayFast. Set one in PayFast → Settings → Developer Settings and enter it here.' }, { status: 400 });
      }
      const keyBox = encryptSecret(merchantKey);
      const passBox = payfastPassIn ? encryptSecret(payfastPassIn) : savedPassBox;
      if (!keyBox || !passBox) return Response.json({ error: 'Could not secure the PayFast details. Please try again.' }, { status: 500 });
      payfastUpdate = { payfastMerchantId: merchantId, payfastMerchantKeyEnc: keyBox, payfastPassphraseEnc: passBox };
      payfastAuditNote = 'payfast_connected';
    } else if (payfastPassIn) {
      // Passphrase on its own — completes a PayFast account saved without one.
      if (provider !== 'payfast') {
        return Response.json({ error: 'Choose PayFast as the processor before saving the PayFast passphrase.' }, { status: 400 });
      }
      if (!saved?.payfastMerchantId || !secretIsSet(saved.payfastMerchantKeyEnc)) {
        return Response.json({ error: 'Enter your PayFast Merchant ID and Merchant key together with the passphrase.' }, { status: 400 });
      }
      const passBox = encryptSecret(payfastPassIn);
      if (!passBox) return Response.json({ error: 'Could not secure the passphrase. Please try again.' }, { status: 500 });
      payfastUpdate = { payfastPassphraseEnc: passBox };
      payfastAuditNote = 'payfast_passphrase_set';
    }

    // Seller-owned Ozow account (instant EFT on Ozow's page). Private key +
    // API key are AES-256-GCM encrypted at rest and never returned by any API.
    let ozowUpdate: { ozowSiteCode?: string | null; ozowPrivateKeyEnc?: string | null; ozowApiKeyEnc?: string | null } | undefined;
    let ozowAuditNote: string | undefined;
    const ozowApiIn = typeof body.ozowApiKey === 'string' ? body.ozowApiKey.trim() : '';
    if (ozowApiIn && !/^[a-zA-Z0-9-]{16,128}$/.test(ozowApiIn)) {
      return Response.json({ error: 'That does not look like an Ozow API key — copy it exactly from your Ozow merchant dashboard (Merchants → Merchant Details).' }, { status: 400 });
    }
    if (body.clearOzow === true) {
      ozowUpdate = { ozowSiteCode: null, ozowPrivateKeyEnc: null, ozowApiKeyEnc: null };
      ozowAuditNote = 'ozow_cleared';
    } else if (typeof body.ozowSiteCode === 'string' && body.ozowSiteCode.trim() && typeof body.ozowPrivateKey === 'string' && body.ozowPrivateKey.trim()) {
      if (provider !== 'ozow') {
        return Response.json({ error: 'Choose Ozow as the processor before saving Ozow site details.' }, { status: 400 });
      }
      const siteCode = body.ozowSiteCode.trim();
      const privateKey = body.ozowPrivateKey.trim();
      if (siteCode.length < 6 || siteCode.length > 64) {
        return Response.json({ error: 'The Ozow Site Code should be copied exactly from your Ozow merchant dashboard (your Site page).' }, { status: 400 });
      }
      // Dashes are part of real Ozow private keys (GUID format, e.g.
      // a1b2c3d4-e5f6-…): sellers copy the key EXACTLY as shown in Settings →
      // Spark, so the format check must accept the exact string they paste.
      if (!/^[a-zA-Z0-9-]{16,128}$/.test(privateKey)) {
        return Response.json({ error: 'That does not look like an Ozow private key — copy it exactly from your Ozow merchant dashboard (Merchants → Merchant Details).' }, { status: 400 });
      }
      // Ozow's payment-request API authenticates with the API key — without
      // it no payment can be created, so it is required (not optional). A
      // key saved earlier is kept when the seller leaves the field blank.
      const savedApiBox = !ozowApiIn && secretIsSet(saved?.ozowApiKeyEnc) ? saved?.ozowApiKeyEnc ?? null : null;
      if (!ozowApiIn && !savedApiBox) {
        return Response.json({ error: 'The Ozow API key is required to take payments — copy it from your Ozow merchant dashboard (Merchants → Merchant Details).' }, { status: 400 });
      }
      const privBox = encryptSecret(privateKey);
      const apiBox = ozowApiIn ? encryptSecret(ozowApiIn) : savedApiBox;
      if (!privBox || !apiBox) return Response.json({ error: 'Could not secure the Ozow details. Please try again.' }, { status: 500 });
      ozowUpdate = { ozowSiteCode: siteCode, ozowPrivateKeyEnc: privBox, ozowApiKeyEnc: apiBox };
      ozowAuditNote = 'ozow_connected';
    } else if (ozowApiIn) {
      // API key on its own — completes an Ozow account saved without one.
      if (provider !== 'ozow') {
        return Response.json({ error: 'Choose Ozow as the processor before saving the Ozow API key.' }, { status: 400 });
      }
      if (!saved?.ozowSiteCode || !secretIsSet(saved.ozowPrivateKeyEnc)) {
        return Response.json({ error: 'Enter your Ozow site code and private key together with the API key.' }, { status: 400 });
      }
      const apiBox = encryptSecret(ozowApiIn);
      if (!apiBox) return Response.json({ error: 'Could not secure the API key. Please try again.' }, { status: 500 });
      ozowUpdate = { ozowApiKeyEnc: apiBox };
      ozowAuditNote = 'ozow_api_key_set';
    }

    const store = await db.store.findUnique({ where: { userId: session.user.id }, select: { id: true, name: true } });
    if (!store) return Response.json({ error: 'Create your store first.' }, { status: 404 });

    // Payout method (where GGPay sends the seller's money after in-app card
    // payments settle). Every field is optional — only provided fields are
    // updated, so partial saves never wipe the rest of the account.
    const ACCOUNT_TYPES = ['cheque', 'savings', 'transmission'];
    const bankErrors: string[] = [];
    const bankIn = {
      bankName: String(body.bankName ?? '').trim(),
      bankAccountType: String(body.bankAccountType ?? '').trim(),
      bankAccountNumber: String(body.bankAccountNumber ?? '').trim(),
      bankBranchCode: String(body.bankBranchCode ?? '').trim(),
      bankAccountHolder: String(body.bankAccountHolder ?? '').trim(),
    };
    if (bankIn.bankName && bankIn.bankName.length < 2) bankErrors.push('Bank name is too short');
    if (bankIn.bankAccountType && !ACCOUNT_TYPES.includes(bankIn.bankAccountType)) bankErrors.push('Select a valid account type (cheque, savings or transmission)');
    if (bankIn.bankAccountNumber && !/^\d{4,17}$/.test(bankIn.bankAccountNumber)) bankErrors.push('Account number must be 4–17 digits');
    if (bankIn.bankBranchCode && !/^\d{4,6}$/.test(bankIn.bankBranchCode)) bankErrors.push('Branch code must be 4–6 digits');
    if (bankIn.bankAccountHolder && bankIn.bankAccountHolder.length < 2) bankErrors.push('Account holder name is too short');
    if (bankErrors.length > 0) return Response.json({ error: bankErrors.join('. ') }, { status: 400 });
    const bankProvided = Object.values(bankIn).some((v) => v.length > 0);
    const bankUpdate = bankProvided
      ? Object.fromEntries(Object.entries(bankIn).filter(([, v]) => v.length > 0))
      : {};

    await db.store.update({
      where: { id: store.id },
      data: { payoutProvider: provider || null, payoutLink: link || null, payoutNote: note.slice(0, 200) || null, ...(yocoUpdate ?? {}), ...(payfastUpdate ?? {}), ...(ozowUpdate ?? {}), ...bankUpdate },
    });
    await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'store_payment_updated', target: store.id, detail: [provider || 'bank_transfer', yocoAuditNote, payfastAuditNote, ozowAuditNote, bankProvided ? 'payout_bank_updated' : null].filter(Boolean).join(' · ') });
    // Payout-destination changes always notify the account owner (in-app +
    // email) — the classic takeover move is quietly redirecting payouts.
    if (bankProvided) {
      const last4 = bankIn.bankAccountNumber ? bankIn.bankAccountNumber.slice(-4) : null;
      void (async () => {
        const { notify } = await import('@/lib/notify');
        const { sendPayoutDetailsChangedEmail } = await import('@/lib/email');
        await notify({
          userId: session.user.id,
          type: 'payout_details_changed',
          title: 'Payout bank details changed',
          body: `The bank account for ${store.name} payouts was updated${last4 ? ` (ending ${last4})` : ''}. If this was not you, reset your password and contact support.`,
          link: '/dashboard',
        });
        await sendPayoutDetailsChangedEmail({ to: session.user.email, storeName: store.name, accountLast4: last4 });
      })().catch(() => undefined);
    }
    return Response.json({ ok: true });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('sellers PATCH error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not save payment details.' }, { status: 500 });
  }
}
