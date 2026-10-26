import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';
import { getSession } from '@/lib/auth';
import { recordInteraction } from '@/lib/recommender';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';

export const dynamic = 'force-dynamic';

// 'purchase' is deliberately NOT client-forgeable: real purchase events are
// recorded server-side inside the checkout transaction (the highest-weight
// recommender signal — letting clients send it would fake popularity).
const VALID_TYPES = ['view', 'cart', 'wishlist'];

/**
 * Real behavioural analytics events (spec #13/#36): sellers see actual
 * views, add-to-cart and wishlist activity for their products.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const rl = rateLimit(`event:${clientIp(req)}:${id}`, 30, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const body = (await readJsonObject(req)) as { type?: string; guestId?: string } | null;
    if (!body) return invalidJsonBody();
    const type = String(body.type ?? '');
    if (!VALID_TYPES.includes(type)) return Response.json({ error: 'Invalid event type' }, { status: 400 });
    const guestId = typeof body.guestId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.guestId) ? body.guestId : null;

    const product = await db.product.findUnique({
      where: { id },
      select: { id: true, brand: true, priceCents: true, salePriceCents: true, category: { select: { slug: true } } },
    });
    if (!product) return Response.json({ error: 'Product not found' }, { status: 404 });

    const session = await getSession();
    await db.productEvent.create({ data: { productId: id, type, userId: session?.user.id ?? null, guestId } });
    if (type === 'view') {
      await db.product.update({ where: { id }, data: { viewCount: { increment: 1 } } });
    }

    // Feed the recommendation engine (fire-and-forget; never blocks the event).
    void recordInteraction({
      productId: id,
      type,
      userId: session?.user.id ?? null,
      guestId: session ? null : guestId,
      catSlug: product.category?.slug ?? null,
      brand: product.brand,
      priceCents: product.salePriceCents ?? product.priceCents,
    }).catch(() => undefined);

    return Response.json({ ok: true });
  } catch (e) {
    console.error('event error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not record event' }, { status: 500 });
  }
}
