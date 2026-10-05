import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';

export const dynamic = 'force-dynamic';

/** Buyer's order history. */
export async function GET() {
  try {
    await bootstrap();
    const session = await requireUser();
    const orders = await db.order.findMany({
      where: { buyerId: session.user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        items: { select: { id: true, productId: true, name: true, variantLabel: true, quantity: true, unitPriceCents: true } },
        store: { select: { id: true, slug: true, name: true } },
      },
    });
    return Response.json({ orders });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('orders GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load your orders.' }, { status: 500 });
  }
}
