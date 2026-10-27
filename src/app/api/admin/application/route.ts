import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireRole, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { APPLICATION_SELECT, applicationView } from '@/lib/seller-application';

export const dynamic = 'force-dynamic';

/** Only images the app itself stored (an inline picture or a storage-bucket https address). */
const shownImage = (v: string | null) => (v && (/^data:image\/(jpeg|png|webp);base64,/.test(v) || /^https:\/\//.test(v)) ? v : null);

/**
 * One store's seller application as the seller filled it in — for any store
 * (waiting, live, suspended or declined), with the logo and banner they sent.
 * Administrators only.
 */
export async function GET(req: NextRequest) {
  try {
    await bootstrap();
    await requireRole('ADMIN');
    const storeId = new URL(req.url).searchParams.get('storeId') ?? '';
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(storeId)) return Response.json({ error: 'Store not found.' }, { status: 404 });
    const store = await db.store.findUnique({
      where: { id: storeId },
      select: { ...APPLICATION_SELECT, logoData: true, bannerData: true, _count: { select: { products: true } } },
    });
    if (!store) return Response.json({ error: 'Store not found.' }, { status: 404 });
    return Response.json(
      {
        application: {
          ...applicationView(store),
          logo: shownImage(store.logoData),
          banner: shownImage(store.bannerData),
          productCount: store._count.products,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('admin application GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load the application.' }, { status: 500 });
  }
}
