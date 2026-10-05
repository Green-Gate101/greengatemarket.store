import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const VALID_TYPES = ['view', 'cart', 'wishlist', 'purchase'];

/**
 * Real behavioural analytics events (spec #13/#36): sellers see actual
 * views, add-to-cart and wishlist activity for their products.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const rl = rateLimit(`event:${clientIp(req)}:${id}`, 30, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const body = (await req.json()) as { type?: string };
    const type = String(body.type ?? '');
    if (!VALID_TYPES.includes(type)) return Response.json({ error: 'Invalid event type' }, { status: 400 });

    const product = await db.product.findUnique({ where: { id }, select: { id: true } });
    if (!product) return Response.json({ error: 'Product not found' }, { status: 404 });

    const session = await getSession();
    await db.productEvent.create({ data: { productId: id, type, userId: session?.user.id ?? null } });
    if (type === 'view') {
      await db.product.update({ where: { id }, data: { viewCount: { increment: 1 } } });
    }
    return Response.json({ ok: true });
  } catch (e) {
    console.error('event error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not record event' }, { status: 500 });
  }
}
