import { NextRequest } from 'next/server';
import { db, IS_POSTGRES } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';
import { sellingStoreWhere } from '@/lib/subscription';

export const dynamic = 'force-dynamic';

/**
 * Search-as-you-type suggestions for the header search box.
 *  - ?q= (1+ characters): matching stores, products and categories.
 *  - no q: popular searches (real searches with results, last 30 days) and
 *    top categories, so the box suggests something the moment it is opened.
 * Only live products from stores that may sell right now. Small, public and
 * identical for everyone, so the CDN caches it briefly.
 */
export async function GET(req: NextRequest) {
  try {
    const rl = rateLimit(`suggest:${clientIp(req)}`, 240, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    await bootstrap();
    const q = String(new URL(req.url).searchParams.get('q') ?? '').trim().slice(0, 80);
    const headers = { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' };
    const ci = IS_POSTGRES ? { mode: 'insensitive' as const } : {};
    const selling = sellingStoreWhere();

    if (!q) {
      const since = new Date(Date.now() - 30 * 86_400_000);
      const [popular, categories] = await Promise.all([
        db.searchLog.groupBy({
          by: ['term'],
          where: { createdAt: { gte: since }, results: { gt: 0 } },
          _count: { _all: true },
          orderBy: { _count: { term: 'desc' } },
          take: 8,
        }),
        db.category.findMany({ where: { parentId: null }, orderBy: { sortOrder: 'asc' }, take: 8, select: { slug: true, name: true } }),
      ]);
      return Response.json({ q, popular: popular.map((p) => p.term).filter((t) => t.length >= 2), categories, stores: [], products: [] }, { headers });
    }

    const words = q.split(/\s+/).filter(Boolean).slice(0, 4);
    let productIds: string[] | null = null;
    if (q.length >= 2) {
      const { searchProductIds } = await import('@/lib/algolia');
      const ids = await searchProductIds(q);
      if (ids && ids.length > 0) productIds = ids.slice(0, 40);
    }
    const productWhere = {
      status: 'approved',
      store: selling,
      ...(productIds
        ? { id: { in: productIds } }
        : { AND: words.map((w) => ({ OR: [{ name: { contains: w, ...ci } }, { brand: { contains: w, ...ci } }, { store: { name: { contains: w, ...ci } } }] })) }),
    };
    const [products, stores, categories] = await Promise.all([
      db.product.findMany({
        where: productWhere,
        orderBy: { viewCount: 'desc' },
        take: 6,
        select: { slug: true, name: true, priceCents: true, salePriceCents: true, images: { orderBy: { position: 'asc' }, take: 1, select: { id: true } }, store: { select: { name: true } } },
      }),
      db.store.findMany({
        where: { ...selling, AND: words.map((w) => ({ OR: [{ name: { contains: w, ...ci } }, { location: { contains: w, ...ci } }] })) },
        orderBy: [{ ratingCount: 'desc' }, { createdAt: 'desc' }],
        take: 4,
        select: { slug: true, name: true, location: true },
      }),
      db.category.findMany({
        where: { AND: words.map((w) => ({ name: { contains: w, ...ci } })) },
        orderBy: { sortOrder: 'asc' },
        take: 4,
        select: { slug: true, name: true },
      }),
    ]);
    return Response.json({
      q,
      popular: [],
      categories,
      stores,
      products: products.map((p) => ({
        slug: p.slug,
        name: p.name,
        priceCents: p.salePriceCents ?? p.priceCents,
        image: p.images[0] ? `/api/images/${p.images[0].id}` : null,
        storeName: p.store.name,
      })),
    }, { headers });
  } catch (e) {
    console.error('search suggest error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load suggestions.' }, { status: 500 });
  }
}
