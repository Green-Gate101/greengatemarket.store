import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { payfastEnabled } from '@/lib/payfast';
import { ggpayAcceptsCards } from '@/lib/ggpay';

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
            select: {
              id: true, slug: true, name: true, payoutProvider: true, payoutLink: true, payoutNote: true,
              // Presence-only fields for the in-app payment methods UI — the
              // encrypted processor secrets themselves are mapped out below
              // and never leave the server.
              payfastMerchantId: true, payfastMerchantKeyEnc: true, ozowSiteCode: true, ozowPrivateKeyEnc: true,
            },
          },
        },
      }),
      db.order.count({ where: { buyerId: session.user.id } }),
    ]);
    return Response.json({
      orders: orders.map((o) => {
        const { payfastMerchantId, payfastMerchantKeyEnc, ozowSiteCode, ozowPrivateKeyEnc, ...store } = o.store;
        return {
          ...o,
          store: {
            ...store,
            payfastReady: Boolean(payfastMerchantId && payfastMerchantKeyEnc),
            ozowReady: Boolean(ozowSiteCode && ozowPrivateKeyEnc),
          },
        };
      }),
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
