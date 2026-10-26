import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { sellingStoreWhere, storeCanSell } from '@/lib/subscription';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { recordInteraction } from '@/lib/recommender';

export const dynamic = 'force-dynamic';

/** Persistent wishlist for authenticated buyers. */
export async function GET(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireUser();
    // Capped at the 300 newest saves per page; `?offset=` pages deeper (the
    // UI's "Load more"); `total` and `hasMore` ride along.
    const WISHLIST_LIMIT = 300;
    const offset = Math.max(0, Math.floor(Number(new URL(req.url).searchParams.get('offset')) || 0));
    const [items, total] = await Promise.all([
      db.wishlistItem.findMany({
        where: { userId: session.user.id },
        orderBy: { createdAt: 'desc' },
        take: WISHLIST_LIMIT,
        skip: offset,
        include: {
          product: {
            select: {
              id: true, slug: true, name: true, priceCents: true, salePriceCents: true, stock: true, status: true,
              store: { select: { name: true, status: true, billingExempt: true, accessUntil: true } },
              images: { orderBy: { position: 'asc' }, take: 1, select: { dataUrl: true } },
              variants: { where: { active: true }, select: { stock: true } },
            },
          },
        },
      }),
      db.wishlistItem.count({ where: { userId: session.user.id } }),
    ]);
    return Response.json({
      items: items
        .filter((i) => i.product.status === 'approved' && storeCanSell(i.product.store))
        .map((i) => ({
          id: i.id,
          productId: i.productId,
          slug: i.product.slug,
          name: i.product.name,
          image: i.product.images[0]?.dataUrl ?? null,
          priceCents: i.product.priceCents,
          salePriceCents: i.product.salePriceCents,
          stock: i.product.stock,
          variantStock: i.product.variants.reduce((sum, v) => sum + v.stock, 0),
          hasVariants: i.product.variants.length > 0,
          storeName: i.product.store.name,
        })),
      total,
      hasMore: total > offset + items.length,
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('wishlist GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load your wishlist.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireUser();
    const body = (await req.json()) as { productId?: string };
    const productId = String(body.productId ?? '');
    const product = await db.product.findUnique({
      where: { id: productId },
      select: { id: true, status: true, brand: true, priceCents: true, salePriceCents: true, category: { select: { slug: true } }, store: { select: { status: true, billingExempt: true, accessUntil: true } } },
    });
    // Only stores that may sell accept new wishlist saves (same rule as the catalogue).
    if (!product || product.status !== 'approved' || !storeCanSell(product.store)) return Response.json({ error: 'This product is not available.' }, { status: 404 });

    const existing = await db.wishlistItem.findUnique({
      where: { userId_productId: { userId: session.user.id, productId } },
    });
    if (existing) {
      await db.wishlistItem.delete({ where: { id: existing.id } });
      return Response.json({ ok: true, saved: false });
    }
    await db.wishlistItem.create({ data: { userId: session.user.id, productId } });
    db.productEvent.create({ data: { productId, type: 'wishlist', userId: session.user.id } }).catch(() => undefined);
    void recordInteraction({
      productId,
      type: 'wishlist',
      userId: session.user.id,
      catSlug: product.category?.slug ?? null,
      brand: product.brand,
      priceCents: product.salePriceCents ?? product.priceCents,
    }).catch(() => undefined);
    return Response.json({ ok: true, saved: true });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('wishlist POST error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not update your wishlist.' }, { status: 500 });
  }
}
