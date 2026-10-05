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
        id: true, slug: true, name: true, description: true, logoData: true, location: true, createdAt: true,
        _count: { select: { products: { where: { status: 'approved' } } } },
      },
    });
    return Response.json({
      stores: stores.map((s) => ({
        id: s.id, slug: s.slug, name: s.name, description: s.description, logoData: s.logoData,
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
    const rl = rateLimit(`store-create:${session.user.id}`, 3, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);

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
    const idNumber = str('idNumber');
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
    const sourcing = str('sourcing');
    const monthlyVolume = str('monthlyVolume');
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
    if (idNumber.length < 6 || idNumber.length > 20) errors.push('Enter a valid ID or passport number');
    if ((businessType === 'pty' || businessType === 'cc') && !registrationNumber) {
      errors.push('Companies and close corporations must provide a registration number');
    }

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

    // Operations
    if (!SOURCING.includes(sourcing)) errors.push('Select where your products come from');
    if (!VOLUMES.includes(monthlyVolume)) errors.push('Select your expected monthly volume');
    if (!Number.isFinite(dispatchDays) || dispatchDays < 1 || dispatchDays > 30) errors.push('Dispatch time must be 1–30 days');
    if (!Number.isFinite(returnsDays) || returnsDays < 0 || returnsDays > 90) errors.push('Return window must be 0–90 days');

    // Declarations
    if (!confirmAge) errors.push('Confirm that you are 18 or older');
    if (!confirmAccuracy) errors.push('Confirm that your application information is accurate');
    if (!confirmTerms) errors.push('Accept the Green Gate seller terms and privacy policy');

    if (errors.length > 0) return Response.json({ error: errors.join('. ') }, { status: 400 });

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
    console.error('sellers POST error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not create the store.' }, { status: 500 });
  }
}
