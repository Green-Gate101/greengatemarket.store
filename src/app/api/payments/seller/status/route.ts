import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { settleOrderPayment } from '@/lib/ggpay';
import { ozowSellerReady, ozowStatusPaid } from '@/lib/seller-payments';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Polling endpoint for the IN-APP payment frames (PayFast Onsite lightbox and
 * Ozow instant-EFT frame). Returns the order's server-side payment state so
 * the UI can react the moment a webhook lands.
 *
 * Belt-and-braces: for Ozow orders with a stored transaction id and a seller
 * API key, this endpoint ALSO runs an authenticated status query and confirms
 * the order directly on positive proof — so a blocked/delayed notify webhook
 * can never strand a paid order.
 */
export async function GET(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireUser();

    // Each poll can fire a signed outbound Ozow status query — bound it so a
    // runaway poller cannot churn the seller's gateway quota.
    const rl = rateLimit(`pay-status:${session.user.id}:${clientIp(req)}`, 60, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const number = new URL(req.url).searchParams.get('number') ?? '';
    if (!/^[A-Z0-9-]{4,32}$/.test(number)) return Response.json({ error: 'Bad order number.' }, { status: 400 });

    const order = await db.order.findFirst({
      where: { number, OR: [{ buyerId: session.user.id }, { buyerEmail: session.user.email }] },
      select: {
        id: true, number: true, status: true, paymentStatus: true, paymentRef: true, totalCents: true,
        buyerEmail: true, buyerName: true, buyerId: true, subtotalCents: true, ozowTransactionId: true,
        store: {
          select: {
            id: true, name: true,
            ozowSiteCode: true, ozowPrivateKeyEnc: true, ozowApiKeyEnc: true,
          },
        },
      },
    });
    if (!order) return Response.json({ error: 'Order not found.' }, { status: 404 });

    // Ozow direct status verification (defensive — never the only proof).
    if (
      order.paymentStatus === 'awaiting_payment' &&
      order.ozowTransactionId &&
      order.store &&
      ozowSellerReady(order.store)
    ) {
      // `request:<id>` = attempt started, no transaction yet: look it up by
      // the order reference; a real transaction id narrows the lookup.
      const knownTx = order.ozowTransactionId.startsWith('request:') ? undefined : order.ozowTransactionId;
      const status = await ozowStatusPaid(order.number, order.store, knownTx, order.totalCents);
      if (status?.paid) {
        const ref = `OZOW-${status.transactionId ?? knownTx ?? order.number}`;
        await settleOrderPayment(
          {
            id: order.id, number: order.number, status: order.status, paymentStatus: order.paymentStatus,
            buyerId: order.buyerId, buyerEmail: order.buyerEmail, storeId: order.store.id,
            subtotalCents: order.subtotalCents, totalCents: order.totalCents,
          },
          { provider: 'ozow', method: 'instant_eft', reference: ref },
        );
        return Response.json({ paymentStatus: 'paid', status: 'confirmed', paymentRef: ref });
      }
    }

    return Response.json({
      paymentStatus: order.paymentStatus,
      status: order.status,
      paymentRef: order.paymentRef,
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('seller status error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not check payment status.' }, { status: 500 });
  }
}
