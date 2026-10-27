import { db } from '@/lib/db';

/**
 * Product events (views, cart/wishlist adds, purchases, publishes) are kept
 * for this many days; the daily cron deletes older ones. One row is written
 * per product view, so without this the table grows with every visitor.
 * Figures meant to last are stored elsewhere and untouched: a product's total
 * views (Product.viewCount), orders, reviews and the recommender's model.
 * Seller analytics says so when a chosen period reaches further back.
 */
export const PRODUCT_EVENT_KEEP_DAYS = 180;

/** Every kind of product event the app records — each pass uses the (type, createdAt) index. */
const EVENT_TYPES = ['view', 'cart', 'wishlist', 'purchase', 'published'];
const CHUNK = 2_000;

/** The oldest moment product events are still kept for. */
export function productEventsKeptSince(now: Date = new Date()): Date {
  return new Date(now.getTime() - PRODUCT_EVENT_KEEP_DAYS * 86_400_000);
}

/**
 * Delete product events older than PRODUCT_EVENT_KEEP_DAYS, a chunk at a time,
 * within `budgetMs`. A large backlog simply finishes over the next runs
 * (`done: false` says there may be more).
 */
export async function pruneOldProductEvents(budgetMs: number, now: Date = new Date()): Promise<{ deleted: number; done: boolean }> {
  const cutoff = productEventsKeptSince(now);
  const stopAt = Date.now() + budgetMs;
  let deleted = 0;
  for (const type of EVENT_TYPES) {
    for (;;) {
      if (Date.now() >= stopAt) return { deleted, done: false };
      const old = await db.productEvent.findMany({ where: { type, createdAt: { lt: cutoff } }, select: { id: true }, take: CHUNK });
      if (old.length === 0) break;
      deleted += (await db.productEvent.deleteMany({ where: { id: { in: old.map((e) => e.id) } } })).count;
      if (old.length < CHUNK) break;
    }
  }
  return { deleted, done: true };
}
