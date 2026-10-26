import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { sellingStoreWhere } from '@/lib/subscription';
import { bootstrap } from '@/lib/bootstrap';
import { getSession } from '@/lib/auth';
import { recommend, similarProducts, type CandidateProduct } from '@/lib/recommender';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * GET /api/recommendations
 *
 * Machine-learning product recommendations. Subject resolution: signed-in
 * user first, otherwise the anonymous browser profile (`guest` id). When
 * `similar` (a product id) is supplied, returns "more like this" neighbours.
 *
 * The engine learns from real behavioural events only — there is no fake or
 * seeded data anywhere in the pipeline.
 */
export async function GET(req: NextRequest) {
  try {
    await bootstrap();
    const rl = rateLimit(`recs:${clientIp(req)}`, 120, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const sp = new URL(req.url).searchParams;
    const limit = Math.min(12, Math.max(2, Number(sp.get('limit') ?? 8) || 8));
    const similarTo = sp.get('similar') ?? '';
    const excludeSlug = sp.get('exclude') ?? '';
    const guestId = sp.get('guest') ?? '';

    const session = await getSession();

    // Candidate pool: approved, purchasable products only.
    const rows = await db.product.findMany({
      where: {
        status: 'approved',
        // Same rule as the catalogue: only ACTIVE stores are recommendable —
        // suspended/declined stores must not keep selling through the rails.
        store: sellingStoreWhere(),
        OR: [{ stock: { gt: 0 } }, { variants: { some: { stock: { gt: 0 }, active: true } } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 400,
      select: {
        id: true, slug: true, name: true, priceCents: true, salePriceCents: true, brand: true,
        stock: true, status: true, createdAt: true, storeId: true,
        store: { select: { id: true, slug: true, name: true, location: true } },
        category: { select: { slug: true, name: true } },
        variants: { where: { active: true }, select: { stock: true } },
        // NOTE: images intentionally NOT selected here — the candidate pool
        // is up to 400 rows and each dataUrl is ~100-250KB of base64. The
        // images for the ~limit returned cards are fetched in one small
        // query below, keeping this hot endpoint's payload bounded.
      },
    });

    const candidates: CandidateProduct[] = rows.map((p) => ({
      id: p.id,
      catSlug: p.category?.slug ?? null,
      brand: p.brand,
      priceCents: p.salePriceCents ?? p.priceCents,
      stock: p.stock,
      variantStock: p.variants.reduce((sum, v) => sum + v.stock, 0),
      storeId: p.storeId,
    }));

    let rankedIds: string[];
    let source: 'personalized' | 'trending' | 'similar';
    let attribution: Record<string, { cf: number; content: number; pop: number }> = {};

    if (similarTo) {
      rankedIds = await similarProducts(similarTo, candidates, limit);
      source = 'similar';
    } else {
      const excluded = excludeSlug ? rows.filter((r) => r.slug === excludeSlug).map((r) => r.id) : [];
      const result = await recommend({
        userId: session?.user.id ?? null,
        guestId: session ? null : guestId,
        limit,
        excludeIds: excluded,
        candidates,
      });
      rankedIds = result.order;
      source = result.source;
      attribution = result.attribution;
    }

    const byId = new Map(rows.map((r) => [r.id, r]));
    const picked = rankedIds.map((id) => byId.get(id)).filter((r): r is (typeof rows)[number] => Boolean(r));

    // Real rating aggregates for the returned slice only.
    const ids = picked.map((p) => p.id);
    const reviewAgg = ids.length
      ? await db.review.groupBy({ by: ['productId'], where: { productId: { in: ids } }, _avg: { rating: true }, _count: { rating: true } })
      : [];
    const ratingMap = new Map(reviewAgg.map((r) => [r.productId, { avg: r._avg.rating ?? 0, count: r._count.rating }]));

    // Bounded image fetch (additive): only the returned slice carries a
    // dataUrl — one small query for ≤12 products instead of 400 candidates.
    const imageRows = ids.length
      ? await db.productImage.findMany({
          where: { productId: { in: ids } },
          orderBy: [{ productId: 'asc' }, { position: 'asc' }],
          // Photo by reference (edge-cached /api/images/<id>), not inline base64.
          select: { productId: true, id: true },
        })
      : [];
    const imageMap = new Map<string, string>();
    for (const img of imageRows) {
      if (!imageMap.has(img.productId)) imageMap.set(img.productId, `/api/images/${img.id}`);
    }

    return Response.json({
      products: picked.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        priceCents: p.priceCents,
        salePriceCents: p.salePriceCents,
        image: imageMap.get(p.id) ?? null,
        categorySlug: p.category?.slug ?? null,
        categoryName: p.category?.name ?? null,
        brand: p.brand,
        stock: p.stock,
        variantStock: p.variants.reduce((sum, v) => sum + v.stock, 0),
        hasVariants: p.variants.length > 0,
        status: p.status,
        createdAt: p.createdAt,
        ratingAvg: Number((ratingMap.get(p.id)?.avg ?? 0).toFixed(2)),
        ratingCount: ratingMap.get(p.id)?.count ?? 0,
        store: p.store,
      })),
      source,
      // Attribution is required client-side to report impression/click feedback.
      // The learned ensemble weights themselves stay server-side — the ranking
      // machinery is an internal detail, never part of the public payload.
      attribution,
    });
  } catch (e) {
    console.error('GET /api/recommendations error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load recommendations.' }, { status: 500 });
  }
}
