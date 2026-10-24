import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { audit } from '@/lib/audit';
import { rateLimitShared, clientIp, tooManyRequests } from '@/lib/rate-limit';
import { chargeCard, paymentRef, settleOrderPayment, validateCard, type CardInput } from '@/lib/ggpay';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GGPay in-app card charge (the Amazon/Takealot-style "Pay now" button).
 *
 * The buyer pays for THEIR OWN order inside the app: the card is validated
 * server-side, charged on the marketplace processor, and — on approval — the
 * order confirms automatically and the seller's payout is queued. Declines
 * are recorded as failed Payment attempts and reported honestly; the order
 * stays awaiting_payment so the buyer can retry or use another method.
 *
 * Full card numbers are never stored or logged (brand + last 4 only).
 */
export async function POST(req: NextRequest) {
  let chargeClaimed = false; // an in-flight card charge holds a claim on the order
  let claimedOrderId: string | null = null;
  try {
    await bootstrap();
    const session = await requireUser();
    const rl = await rateLimitShared(`ggpay:${session.user.id}:${clientIp(req)}`, 15, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const body = (await req.json()) as Partial<CardInput> & { orderNumber?: string };
    const orderNumber = String(body.orderNumber ?? '').trim();
    if (!orderNumber) return Response.json({ error: 'Missing order number.' }, { status: 400 });

    // Ownership guard: only the buyer of the order can pay it.
    const order = await db.order.findFirst({
      where: { number: orderNumber, OR: [{ buyerId: session.user.id }, { buyerEmail: session.user.email }] },
      include: { payout: true },
    });
    if (!order) return Response.json({ error: 'Order not found.' }, { status: 404 });

    // Terminal orders can never be paid: a cancelled or refunded order must
    // not accept a card charge (the card would be charged with nothing to
    // deliver and nothing to refund automatically).
    if (order.status === 'cancelled' || order.status === 'refunded') {
      return Response.json({ error: 'This order was cancelled — it can no longer be paid.' }, { status: 409 });
    }

    if (order.paymentStatus === 'paid' || order.payout) {
      return Response.json({
        ok: true,
        alreadyPaid: true,
        order: { number: order.number, status: order.status, paymentStatus: order.paymentStatus, paymentRef: order.paymentRef },
      });
    }
    // Stale-claim release: a previous charge that crashed mid-flight leaves
    // the order in processing_payment — after 15 minutes it is released so
    // the buyer can never be permanently locked out of paying.
    if (order.paymentStatus === 'processing_payment') {
      const claimedAt = new Date(order.updatedAt).getTime();
      if (Number.isFinite(claimedAt) && Date.now() - claimedAt > 15 * 60_000) {
        const released = await db.order.updateMany({ where: { id: order.id, paymentStatus: 'processing_payment' }, data: { paymentStatus: 'awaiting_payment' } });
        if (released.count > 0) order.paymentStatus = 'awaiting_payment';
      }
    }
    if (order.paymentStatus !== 'awaiting_payment') {
      return Response.json({ error: 'A payment attempt is already in progress — please wait a moment and try again.' }, { status: 409 });
    }

    // Server-side validation — the browser form is convenience only.
    const card = validateCard({
      cardNumber: String(body.cardNumber ?? ''),
      cardName: String(body.cardName ?? ''),
      expiry: String(body.expiry ?? ''),
      cvv: String(body.cvv ?? ''),
    });
    if (!card.ok) {
      return Response.json({ error: card.error }, { status: 400 });
    }

    // Atomic claim: exactly ONE in-flight charge per order, so a double click
    // or two parallel tabs can never charge the card twice. Released on every
    // failure path; a successful settlement marks the order paid.
    const claim = await db.order.updateMany({
      where: { id: order.id, paymentStatus: 'awaiting_payment' },
      data: { paymentStatus: 'processing_payment' },
    });
    if (claim.count === 0) {
      return Response.json({ error: 'A payment attempt is already in progress — please wait a moment and try again.' }, { status: 409 });
    }
    chargeClaimed = true;
    claimedOrderId = order.id;

    const reference = paymentRef();
    const result = await chargeCard(order.totalCents, card);

    if (!result.ok) {
      // Honest decline: record the attempt, keep the order unpaid.
      await db.payment.create({
        data: {
          orderId: order.id,
          provider: 'ggpay_card',
          method: 'card',
          status: 'failed',
          amountCents: order.totalCents,
          reference,
          cardBrand: result.brand ?? card.brand ?? null,
          cardLast4: result.last4 ?? card.last4 ?? null,
          failureReason: result.reason ?? 'declined',
        },
      });
      await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'payment_declined', target: order.number, detail: `${result.reason} · ${result.brand ?? card.brand} ·· ${result.last4 ?? card.last4}` }).catch(() => undefined);
      // Release the claim — the buyer must be able to retry with another card.
      await db.order.updateMany({ where: { id: order.id, paymentStatus: 'processing_payment' }, data: { paymentStatus: 'awaiting_payment' } });
      chargeClaimed = false;
      return Response.json({ ok: false, declined: true, error: result.reason ?? 'The payment was declined.' }, { status: 402 });
    }

    const settle = await settleOrderPayment(order, {
      provider: 'ggpay_card',
      method: 'card',
      reference,
      cardBrand: result.brand ?? null,
      cardLast4: result.last4 ?? null,
    });

    // Lost an extremely tight race (another verified path settled the order
    // between our claim and the settle call). Report the REAL order state —
    // never a fabricated success.
    if (!settle.settled) {
      const now = await db.order.findUnique({ where: { id: order.id }, select: { status: true, paymentStatus: true, paymentRef: true } });
      if (now?.paymentStatus === 'paid') {
        return Response.json({
          ok: true,
          alreadyPaid: true,
          order: { number: order.number, status: now.status, paymentStatus: now.paymentStatus, paymentRef: now.paymentRef },
        });
      }
      return Response.json({ error: 'This order can no longer be paid in this state. Please review it in My orders.' }, { status: 409 });
    }

    return Response.json({
      ok: true,
      paid: true,
      order: { number: order.number, status: 'confirmed', paymentStatus: 'paid', paymentRef: reference },
      payment: { reference, brand: result.brand, last4: result.last4, amountCents: order.totalCents },
      payout: settle.payoutReference
        ? { reference: settle.payoutReference, netCents: settle.sellerNetCents }
        : null,
    });
  } catch (e) {
    // Release the in-flight claim on ANY failure so the buyer can retry.
    if (chargeClaimed && claimedOrderId) {
      await db.order.updateMany({ where: { id: claimedOrderId, paymentStatus: 'processing_payment' }, data: { paymentStatus: 'awaiting_payment' } }).catch(() => undefined);
    }
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('ggpay charge error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Payment could not be processed. Please try again.' }, { status: 500 });
  }
}
