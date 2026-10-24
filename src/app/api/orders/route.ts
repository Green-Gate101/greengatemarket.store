import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { payfastEnabled } from '@/lib/payfast';
import { ggpayAcceptsCards } from '@/lib/ggpay';
import { publicPaymentStore, STORE_PAYMENT_SELECT } from '@/lib/order-payment-options';

export const dynamic = 'force-dynamic';

/** Buyer's order history. Capped at the 200 most recent orders per page so the
 *  response stays fast and bounded at marketplace scale. `?offset=` pages
 *  through older orders (the UI's "Load more"); `total` and `hasMore` ride
 *  along so the UI knows there is more. */
export async function GET(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireUser();
    const ORDER_HISTORY_LIMIT = 200;
    const offset = Math.max(0, Math.floor(Number(new URL(req.url).searchParams.get('offset')) || 0));
    const [orders, total] = await Promise.all([
      db.order.findMany({
        where: { buyerId: session.user.id },
        orderBy: { createdAt: 'desc' },
        take: ORDER_HISTORY_LIMIT,
        skip: offset,
        include: {
          items: { select: { id: true, productId: true, name: true, variantLabel: true, quantity: true, unitPriceCents: true } },
          store: {
            // Payment readiness is computed server-side (publicPaymentStore);
            // secrets and bank columns are mapped out and never leave here.
            select: { id: true, slug: true, name: true, ...STORE_PAYMENT_SELECT },
          },
        },
      }),
      db.order.count({ where: { buyerId: session.user.id } }),
    ]);
    return Response.json({
      // Every order here is the caller's own, so unpaid ones carry the
      // seller's EFT details.
      orders: orders.map((o) => ({ ...o, store: publicPaymentStore(o.store, o, { showEft: true }) })),
      total,
      hasMore: total > offset + orders.length,
      payments: { payfast: payfastEnabled(), ggpay: ggpayAcceptsCards() },
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('orders GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load your orders.' }, { status: 500 });
  }
}
