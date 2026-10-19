import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, requireRole, authErrorResponse } from '@/lib/auth';
import { storeSlug } from '@/lib/password';
import { guardImage } from '@/lib/ai-image-guard';
import { audit } from '@/lib/audit';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';
import { bootstrap } from '@/lib/bootstrap';
import { encryptSecret, secretIsSet } from '@/lib/secret-box';
import { yocoKeyLooksValid } from '@/lib/yoco';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Public store directory. When ?mine=1, returns the caller's own store. */
export async function GET(req: NextRequest) {
  try {
    await bootstrap();
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
              yocoKeySet: Boolean(yocoSecretKey),
              payfastKeySet: Boolean(mine.payfastMerchantId && secretIsSet(payfastMerchantKeyEnc)),
              ozowKeySet: Boolean(mine.ozowSiteCode && secretIsSet(ozowPrivateKeyEnc)),
            }
          : null,
      });
    }
    // Capped at the 200 newest active stores so this PUBLIC directory (which
    // carries base64 logo/banner data per row) stays bounded at marketplace
    // scale; `total` and `hasMore` ride along for future paging.
    const DIRECTORY_LIMIT = 200;
    const [stores, total] = await Promise.all([
      db.store.findMany({
        where: { status: 'active' },
        orderBy: { createdAt: 'desc' },
        take: DIRECTORY_LIMIT,
        select: {
          id: true, slug: true, name: true, description: true, logoData: true, bannerData: true, location: true, createdAt: true,
          _count: { select: { products: { where: { status: 'approved' } } } },
        },
      }),
      db.store.count({ where: { status: 'active' } }),
    ]);
    return Response.json({
      stores: stores.map((s) => ({
        id: s.id, slug: s.slug, name: s.name, description: s.description, logoData: s.logoData, bannerData: s.bannerData,
        location: s.location, createdAt: s.createdAt.toISOString(), productCount: s._count.products,
      })),
      total,
      hasMore: total > stores.length,
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

    const form = await req.formData();
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
    const rl = rateLimit(`store-create:${session.user.id}`, 3, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const imageFiles = form.getAll('images').filter((f): f is File => f instanceof File && f.size > 0);
    const logoData: string | null = imageFiles[0] ? await guardedDataUrl(imageFiles[0]) : null;
    const bannerData: string | null = imageFiles[1] ? await guardedDataUrl(imageFiles[1]) : null;
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
 * forensics. Returns the image as a data URL, or 'REJECTED'.
 */
async function guardedDataUrl(file: File): Promise<string | 'REJECTED'> {
  if (file.size > STORE_IMAGE_MAX_BYTES) return 'REJECTED';
  const buf = Buffer.from(await file.arrayBuffer());
  const mime = sniffImageMime(buf);
  if (!mime || !STORE_IMAGE_MIME.includes(mime as (typeof STORE_IMAGE_MIME)[number])) return 'REJECTED';
  const guard = await guardImage(buf, mime);
  if (!guard.allowed) return 'REJECTED';
  return `data:${mime};base64,${buf.toString('base64')}`;
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
    const session = await requireRole('SELLER');
    const rl = rateLimit(`seller-payment:${session.user.id}:${clientIp(req)}`, 20, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const body = (await req.json()) as { payoutProvider?: string; payoutLink?: string; payoutNote?: string; yocoSecretKey?: string; clearYocoKey?: boolean; bankName?: string; bankAccountType?: string; bankAccountNumber?: string; bankBranchCode?: string; bankAccountHolder?: string; payfastMerchantId?: string; payfastMerchantKey?: string; payfastPassphrase?: string; clearPayfast?: boolean; ozowSiteCode?: string; ozowPrivateKey?: string; ozowApiKey?: string; clearOzow?: boolean; };
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
        return Response.json({ error: 'That does not look like a Yoco secret key — it should start with sk_live_ or sk_test_. Find it in the Yoco Portal under Online payments → Payment gateway.' }, { status: 400 });
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
    let payfastUpdate: { payfastMerchantId: string | null; payfastMerchantKeyEnc: string | null; payfastPassphraseEnc: string | null } | undefined;
    let payfastAuditNote: string | undefined;
    if (body.clearPayfast === true) {
      payfastUpdate = { payfastMerchantId: null, payfastMerchantKeyEnc: null, payfastPassphraseEnc: null };
      payfastAuditNote = 'payfast_cleared';
    } else if (typeof body.payfastMerchantId === 'string' && body.payfastMerchantId.trim() && typeof body.payfastMerchantKey === 'string' && body.payfastMerchantKey.trim()) {
      if (provider !== 'payfast') {
        return Response.json({ error: 'Choose PayFast as the processor before saving PayFast merchant details.' }, { status: 400 });
      }
      const merchantId = body.payfastMerchantId.trim();
      const merchantKey = body.payfastMerchantKey.trim();
      const passphrase = (body.payfastPassphrase ?? '').trim();
      if (!/^\d{5,20}$/.test(merchantId)) {
        return Response.json({ error: 'PayFast merchant IDs are numeric — copy the Merchant ID exactly as shown in your PayFast dashboard (Settings → Integration).' }, { status: 400 });
      }
      if (merchantKey.length < 6 || merchantKey.length > 64) {
        return Response.json({ error: 'That does not look like a PayFast merchant key — copy the Merchant Key exactly as shown in your PayFast dashboard (Settings → Integration).' }, { status: 400 });
      }
      if (passphrase && passphrase.length < 4) {
        return Response.json({ error: 'The PayFast passphrase must be at least 4 characters (set one in Settings → Integration if you have not).' }, { status: 400 });
      }
      const keyBox = encryptSecret(merchantKey);
      const passBox = passphrase ? encryptSecret(passphrase) : null;
      if (!keyBox) return Response.json({ error: 'Could not secure the merchant key. Please try again.' }, { status: 500 });
      payfastUpdate = { payfastMerchantId: merchantId, payfastMerchantKeyEnc: keyBox, payfastPassphraseEnc: passBox };
      payfastAuditNote = 'payfast_connected';
    }

    // Seller-owned Ozow account for IN-APP instant-EFT payments (the buyer
    // completes bank selection inside an in-app frame). Private key + API key
    // are AES-256-GCM encrypted at rest and never returned by any API.
    let ozowUpdate: { ozowSiteCode: string | null; ozowPrivateKeyEnc: string | null; ozowApiKeyEnc: string | null } | undefined;
    let ozowAuditNote: string | undefined;
    if (body.clearOzow === true) {
      ozowUpdate = { ozowSiteCode: null, ozowPrivateKeyEnc: null, ozowApiKeyEnc: null };
      ozowAuditNote = 'ozow_cleared';
    } else if (typeof body.ozowSiteCode === 'string' && body.ozowSiteCode.trim() && typeof body.ozowPrivateKey === 'string' && body.ozowPrivateKey.trim()) {
      if (provider !== 'ozow') {
        return Response.json({ error: 'Choose Ozow as the processor before saving Ozow site details.' }, { status: 400 });
      }
      const siteCode = body.ozowSiteCode.trim();
      const privateKey = body.ozowPrivateKey.trim();
      const apiKey = (body.ozowApiKey ?? '').trim();
      if (siteCode.length < 6 || siteCode.length > 64) {
        return Response.json({ error: 'The Ozow Site Code should be copied exactly from your Ozow merchant dashboard (Settings → Spark).' }, { status: 400 });
      }
      // Dashes are part of real Ozow private keys (GUID format, e.g.
      // a1b2c3d4-e5f6-…): sellers copy the key EXACTLY as shown in Settings →
      // Spark, so the format check must accept the exact string they paste.
      // Same charset rule as the API key below; length still enforced.
      if (!/^[a-zA-Z0-9-]{16,128}$/.test(privateKey)) {
        return Response.json({ error: 'That does not look like an Ozow private key — copy it exactly from your Ozow merchant dashboard (Settings → Spark).' }, { status: 400 });
      }
      if (apiKey && !/^[a-zA-Z0-9-]{16,128}$/.test(apiKey)) {
        return Response.json({ error: 'That does not look like an Ozow API key — copy it exactly from your Ozow merchant dashboard (Settings → API).' }, { status: 400 });
      }
      const privBox = encryptSecret(privateKey);
      const apiBox = apiKey ? encryptSecret(apiKey) : null;
      if (!privBox) return Response.json({ error: 'Could not secure the private key. Please try again.' }, { status: 500 });
      ozowUpdate = { ozowSiteCode: siteCode, ozowPrivateKeyEnc: privBox, ozowApiKeyEnc: apiBox };
      ozowAuditNote = 'ozow_connected';
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
    return Response.json({ ok: true });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('sellers PATCH error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not save payment details.' }, { status: 500 });
  }
}
