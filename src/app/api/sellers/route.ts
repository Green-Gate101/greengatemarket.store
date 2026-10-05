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

    const errors: string[] = [];
    if (name.length < 2 || name.length > 60) errors.push('Store name must be 2–60 characters');
    if (location.length < 2) errors.push('Enter your location (city/suburb)');
    if (phone.replace(/\D/g, '').length < 9) errors.push('Enter a valid contact number');
    if (errors.length > 0) return Response.json({ error: errors.join('. ') }, { status: 400 });

    const imageFiles = form.getAll('images').filter((f): f is File => f instanceof File && f.size > 0);
    const logoData: string | null = imageFiles[0] ? await guardedDataUrl(imageFiles[0]) : null;
    const bannerData: string | null = imageFiles[1] ? await guardedDataUrl(imageFiles[1]) : null;
    if (logoData === 'REJECTED' || bannerData === 'REJECTED') {
      return Response.json({ error: 'Store images rejected: AI-generated images are not permitted. Upload real photos.' }, { status: 422 });
    }

    const store = await db.$transaction(async (tx) => {
      const created = await tx.store.create({
        data: { userId: session.user.id, slug: storeSlug(name), name, description, location, phone, logoData, bannerData },
      });
      await tx.user.update({ where: { id: session.user.id }, data: { role: session.user.role === 'ADMIN' ? 'ADMIN' : 'SELLER' } });
      return created;
    });

    await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'store_created', target: store.slug, detail: name, ip: clientIp(req) });
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
