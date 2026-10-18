import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { payfastEnabled } from '@/lib/payfast';

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
    });
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
      payments: { payfast: payfastEnabled() },
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('orders GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load your orders.' }, { status: 500 });
  }
}
