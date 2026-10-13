import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, requireRole, authErrorResponse } from '@/lib/auth';
import { storeSlug } from '@/lib/password';
import { guardImage } from '@/lib/ai-image-guard';
import { audit } from '@/lib/audit';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';
import { bootstrap } from '@/lib/bootstrap';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Public store directory. When ?mine=1, returns the caller's own store. */
export async function GET(req: NextRequest) {
  try {
    await bootstrap();
    if (new URL(req.url).searchParams.get('mine') === '1') {
      const session = await requireUser();
      const mine = await db.store.findUnique({ where: { userId: session.user.id } });
      return Response.json({ store: mine });
    }
    const stores = await db.store.findMany({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, slug: true, name: true, description: true, logoData: true, bannerData: true, location: true, createdAt: true,
        _count: { select: { products: { where: { status: 'approved' } } } },
      },
    });
    return Response.json({
      stores: stores.map((s) => ({
        id: s.id, slug: s.slug, name: s.name, description: s.description, logoData: s.logoData, bannerData: s.bannerData,
        location: s.location, createdAt: s.createdAt.toISOString(), productCount: s._count.products,
      })),
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
