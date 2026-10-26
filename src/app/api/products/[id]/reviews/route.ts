import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { sellingStoreWhere, storeCanSell } from '@/lib/subscription';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { rateLimitShared, tooManyRequests } from '@/lib/rate-limit';
import { audit } from '@/lib/audit';
import { bootstrap } from '@/lib/bootstrap';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';

export const dynamic = 'force-dynamic';

/** Reviews for a product. The server decides "verified purchase" — never the client. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const reviews = await db.review.findMany({
      where: { productId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { name: true } } },
    });
    return Response.json({
      reviews: reviews.map((r) => ({
        id: r.id, rating: r.rating, title: r.title, body: r.body, verified: r.verified,
        createdAt: r.createdAt.toISOString(), authorName: r.user.name,
      })),
    });
  } catch (e) {
    console.error('reviews GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load reviews' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await bootstrap();
    const session = await requireUser();
    const rl = await rateLimitShared(`review:${session.user.id}`, 10, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const { id } = await ctx.params;
    const body = (await readJsonObject(req)) as { rating?: number; title?: string; body?: string } | null;
    if (!body) return invalidJsonBody();
    const rating = Number(body.rating);
    const text = String(body.body ?? '').trim();
    const title = String(body.title ?? '').trim() || null;

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return Response.json({ error: 'Rating must be between 1 and 5' }, { status: 400 });
    }
    if (text.length < 10) return Response.json({ error: 'Review must be at least 10 characters' }, { status: 400 });
    if (text.length > 2000) return Response.json({ error: 'Review must be at most 2000 characters' }, { status: 400 });

    const product = await db.product.findUnique({ where: { id }, select: { id: true, status: true, store: { select: { userId: true, status: true, billingExempt: true, accessUntil: true } } } });
    if (!product || product.status !== 'approved' || !storeCanSell(product.store)) {
      return Response.json({ error: 'This product is not available.' }, { status: 404 });
    }
    // Reviews must be honest: a seller cannot rate their own listings.
    if (product.store.userId === session.user.id) {
      return Response.json({ error: 'You cannot review products from your own store.' }, { status: 403 });
    }

    // Verified purchase: a real paid order containing this product, belonging to this user.
    const purchase = await db.orderItem.findFirst({
      where: {
        productId: id,
        order: { buyerId: session.user.id, paymentStatus: 'paid', status: { notIn: ['cancelled', 'refunded'] } },
      },
      select: { id: true },
    });

    // Pre-upsert state: does this user already have a review here, and at
    // what rating? Needed to maintain the store's denormalised rating.
    const existing = await db.review.findUnique({
      where: { productId_userId: { productId: id, userId: session.user.id } },
      select: { rating: true },
    });

    const review = await db.review.upsert({
      where: { productId_userId: { productId: id, userId: session.user.id } },
      update: { rating, title, body: text, verified: Boolean(purchase) },
      create: { productId: id, userId: session.user.id, rating, title, body: text, verified: Boolean(purchase) },
    });

    // Store rating maintenance (denormalised on Store — added additively):
    // a NEW review adds its rating; an EDITED review adjusts the running sum
    // by the delta so the store average always matches its reviews.
    const productStore = await db.product.findUnique({ where: { id }, select: { storeId: true } });
    if (productStore) {
      if (existing && existing.rating !== rating) {
        await db.store.update({
          where: { id: productStore.storeId },
          data: { ratingSum: { increment: rating - existing.rating } },
        });
      } else if (!existing) {
        await db.store.update({
          where: { id: productStore.storeId },
          data: { ratingSum: { increment: rating }, ratingCount: { increment: 1 } },
        });
      }
    }

    await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'review_created', target: id, detail: `rating=${rating} verified=${review.verified}` });
    return Response.json({ ok: true, verified: review.verified }, { status: 201 });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('reviews POST error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not save the review.' }, { status: 500 });
  }
}
