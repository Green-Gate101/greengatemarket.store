import { db } from '@/lib/db';
import { requireRole, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';

export const dynamic = 'force-dynamic';

/** The signed-in seller's own catalogue — includes disabled and archived items. */
export async function GET() {
  try {
    await bootstrap();
    const session = await requireRole('SELLER', 'ADMIN');
    const store = await db.store.findUnique({ where: { userId: session.user.id } });
    if (!store) return Response.json({ products: [] });

    const products = await db.product.findMany({
      where: { storeId: store.id, status: { not: 'archived' } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, slug: true, name: true, priceCents: true, salePriceCents: true, stock: true, status: true, createdAt: true,
        store: { select: { id: true, slug: true, name: true, location: true } },
        category: { select: { slug: true, name: true } },
        images: { orderBy: { position: 'asc' }, take: 1, select: { dataUrl: true } },
      },
    });

    return Response.json({
      products: products.map((p) => ({
        ...p,
        image: p.images[0]?.dataUrl ?? null,
        images: undefined,
        ratingAvg: 0,
        ratingCount: 0,
      })),
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('seller products error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load your products.' }, { status: 500 });
  }
}
