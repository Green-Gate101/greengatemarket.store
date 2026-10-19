/**
 * One-time backfill: recompute every store's denormalised rating
 * (ratingSum / ratingCount) from its existing product reviews.
 *
 * Run: DATABASE_URL=file:./db/custom.db bun run scripts/backfill-store-ratings.ts
 * Safe to re-run — it sets absolute values, never increments.
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const products = await db.product.findMany({ select: { id: true, storeId: true } });
  const storeByProduct = new Map(products.map((p) => [p.id, p.storeId]));

  const reviews = await db.review.findMany({ select: { productId: true, rating: true } });
  const sums = new Map<string, { sum: number; count: number }>();
  for (const r of reviews) {
    const storeId = storeByProduct.get(r.productId);
    if (!storeId) continue;
    const cur = sums.get(storeId) ?? { sum: 0, count: 0 };
    cur.sum += r.rating;
    cur.count += 1;
    sums.set(storeId, cur);
  }

  const stores = await db.store.findMany({ select: { id: true } });
  let updated = 0;
  for (const s of stores) {
    const agg = sums.get(s.id) ?? { sum: 0, count: 0 };
    await db.store.update({ where: { id: s.id }, data: { ratingSum: agg.sum, ratingCount: agg.count } });
    updated += 1;
  }
  console.log(`[backfill-store-ratings] ${updated} stores updated; ${sums.size} with ratings.`);
  await db.$disconnect();
}

void main();
