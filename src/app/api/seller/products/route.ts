import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireStoreSeller, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';

export const dynamic = 'force-dynamic';

/** "Size: M · Colour: Red" from the stored attribute JSON (SKU if unreadable). */
function variantLabel(attributes: string, sku: string): string {
  try {
    const a = JSON.parse(attributes) as Record<string, string>;
    const parts = Object.entries(a).filter(([, v]) => String(v).trim()).map(([k, v]) => `${k}: ${v}`);
    return parts.length > 0 ? parts.join(' · ') : sku;
  } catch {
    return sku;
  }
}

/** The signed-in seller's own catalogue — includes disabled and archived items. */
export async function GET(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireStoreSeller();
    const store = await db.store.findUnique({ where: { userId: session.user.id } });
    if (!store) return Response.json({ products: [] });

    // Capped at the 500 newest listings per page; `?offset=` pages through
    // older listings (the UI's "Load more"); `total` and `hasMore` ride along.
    const CATALOGUE_LIMIT = 500;
    const offset = Math.max(0, Math.floor(Number(new URL(req.url).searchParams.get('offset')) || 0));
    const [products, total] = await Promise.all([
      db.product.findMany({
        where: { storeId: store.id, status: { not: 'archived' } },
        orderBy: { createdAt: 'desc' },
        take: CATALOGUE_LIMIT,
        skip: offset,
        select: {
          id: true, slug: true, name: true, priceCents: true, salePriceCents: true, stock: true, status: true, createdAt: true,
          store: { select: { id: true, slug: true, name: true, location: true } },
          category: { select: { slug: true, name: true } },
          images: { orderBy: { position: 'asc' }, take: 1, select: { dataUrl: true } },
          // Products with sizes keep their stock on the sizes (product row = 0).
          variants: { where: { active: true }, orderBy: { sku: 'asc' }, select: { id: true, sku: true, attributes: true, stock: true } },
        },
      }),
      db.product.count({ where: { storeId: store.id, status: { not: 'archived' } } }),
    ]);

    return Response.json({
      products: products.map((p) => ({
        ...p,
        image: p.images[0]?.dataUrl ?? null,
        images: undefined,
        variantStock: p.variants.reduce((sum, v) => sum + v.stock, 0),
        hasVariants: p.variants.length > 0,
        variants: p.variants.map((v) => ({ id: v.id, sku: v.sku, stock: v.stock, label: variantLabel(v.attributes, v.sku) })),
        ratingAvg: 0,
        ratingCount: 0,
      })),
      total,
      hasMore: total > offset + products.length,
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('seller products error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load your products.' }, { status: 500 });
  }
}
