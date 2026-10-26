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
    // Generous: mobile carriers put many shoppers behind one address, and
    // every pause in typing asks once (identical answers come from the CDN).
    const rl = rateLimit(`suggest:${clientIp(req)}`, 600, 60_000);
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
          take: 30,
        }),
        db.category.findMany({ where: { parentId: null }, orderBy: { sortOrder: 'asc' }, take: 8, select: { slug: true, name: true } }),
      ]);
      // Popular searches are shown to everyone, so only plain words make the
      // list — never addresses, emails or links someone searched repeatedly.
      const plain = (t: string) => /^[\p{L}\p{N}][\p{L}\p{N} '&-]{1,39}$/u.test(t) && !/\b(https?|www)\b/i.test(t);
      return Response.json({ q, popular: popular.map((p) => p.term).filter(plain).slice(0, 8), categories, stores: [], products: [] }, { headers });
    }

    const words = q.split(/\s+/).filter(Boolean).slice(0, 4);
    let productIds: string[] | null = null;
    if (q.length >= 2) {
      const { searchProductIds } = await import('@/lib/algolia');
      const ids = await searchProductIds(q);
      if (ids && ids.length > 0) productIds = ids.slice(0, 40);
    }
    const wordsWhere = { AND: words.map((w) => ({ OR: [{ name: { contains: w, ...ci } }, { brand: { contains: w, ...ci } }, { store: { name: { contains: w, ...ci } } }] })) };
    const findProducts = (where: typeof wordsWhere | { id: { in: string[] } }) => db.product.findMany({
      where: { status: 'approved', store: selling, ...where },
      orderBy: { viewCount: 'desc' },
      take: 6,
      select: { slug: true, name: true, priceCents: true, salePriceCents: true, images: { orderBy: { position: 'asc' }, take: 1, select: { id: true } }, store: { select: { name: true } } },
    });
    const [algoliaProducts, stores, categories] = await Promise.all([
      findProducts(productIds ? { id: { in: productIds } } : wordsWhere),
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
    // Algolia's index can lag behind removed or unapproved listings: when
    // none of its hits is live, the database answers (as the full search does).
    const products = productIds && algoliaProducts.length === 0 ? await findProducts(wordsWhere) : algoliaProducts;
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
