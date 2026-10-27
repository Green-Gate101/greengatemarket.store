import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { decryptSecret } from '@/lib/secret-box';
import { yocoRetrieveCheckout, confirmYocoPayment, yocoKeyUsable } from '@/lib/yoco';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Yoco webhook receiver (payment.succeeded and friends).
 *
 * Sellers point their Yoco portal webhook at this URL. Yoco's guidance is to
 * confirm the final outcome via webhook rather than the success redirect —
 * but we never trust a webhook body on its own: the handler re-retrieves the
 * checkout session from Yoco with the SELLER's key and confirms the order
 * only on positive proof. Payload shapes are parsed defensively so Yoco can
 * evolve them without breaking confirmation.
 *
 * Always responds 200 (except malformed JSON) so Yoco does not retry-storm;
 * genuine delivery issues are retried by Yoco only for non-200s, which we
 * reserve for real faults.
 */
export async function POST(req: NextRequest) {
  try {
    // Public webhook — every hit triggers a signed outbound Yoco lookup, so
    // a per-IP ceiling keeps that surface from being hammered.
    const rl = rateLimit(`yoco-webhook:${clientIp(req)}`, 120, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    await bootstrap();
    const raw = await req.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return new Response('bad json', { status: 400 });
    }

    const data = (body.data ?? {}) as Record<string, unknown>;
    const eventType = String(body.eventType ?? body.type ?? body.event ?? '');
    const checkoutId = String(data.checkoutId ?? data.checkout_id ?? body.checkoutId ?? body.checkout_id ?? data.id ?? body.id ?? '');
    const transactionId = String(
      ((data.metadata ?? {}) as Record<string, unknown>).transactionId ?? ((body.metadata ?? {}) as Record<string, unknown>).transactionId ?? '',
    );

    // Find the order: by stored checkout id first, then by our metadata.
    // NOTE: the payload checkoutId is NEVER trusted as a lookup on its own —
    // the webhook body is attacker-controllable, so a cheap checkout created
    // on the seller's account could otherwise be substituted here. Only the
    // checkout id WE stored on the order (or our own order number) is used.
    const order = checkoutId
      ? await db.order.findFirst({ where: { yocoCheckoutId: checkoutId }, select: { id: true, number: true, status: true, paymentStatus: true, buyerId: true, buyerEmail: true, paymentRef: true, yocoCheckoutId: true, totalCents: true, store: { select: { yocoSecretKey: true } } } })
      : null;
    const found = order ?? (transactionId
      ? await db.order.findUnique({ where: { number: transactionId }, select: { id: true, number: true, status: true, paymentStatus: true, buyerId: true, buyerEmail: true, paymentRef: true, yocoCheckoutId: true, totalCents: true, store: { select: { yocoSecretKey: true } } } })
      : null);
    if (!found) return new Response('ok', { status: 200 });
    if (found.paymentStatus !== 'awaiting_payment') return new Response('ok', { status: 200 });

    const lookupId = found.yocoCheckoutId;
    const secret = found.store.yocoSecretKey ? decryptSecret(found.store.yocoSecretKey) : null;
    // A test key never confirms a live order (no money moved).
    const checkout = lookupId && secret && yocoKeyUsable(secret) ? await yocoRetrieveCheckout(secret, lookupId) : null;
    if (!checkout?.paid) return new Response('ok', { status: 200 });

    // Amount binding: the retrieved checkout must have been created for the
    // order's exact total. A paid-but-cheaper checkout (or a checkout whose
    // amount Yoco did not report) is never accepted as proof.
    if (checkout.amountCents === null || checkout.amountCents !== found.totalCents) {
      console.error(`yoco webhook amount mismatch for ${found.number}: checkout ${checkout.amountCents ?? 'unknown'} vs order ${found.totalCents}`);
      return new Response('ok', { status: 200 });
    }

    const ref = `YOCO-${lookupId ?? found.number}`;
    // From here on Yoco's own API has positively confirmed a paid checkout
    // for this order's exact amount — a failure on OUR side must answer 500
    // so Yoco retries the webhook (answering 200 would strand a paid order
    // in awaiting_payment forever).
    let confirmed = false;
    try {
      confirmed = await confirmYocoPayment(found, ref);
    } catch (confirmError) {
      console.error(`yoco webhook confirm threw for ${found.number}:`, confirmError instanceof Error ? confirmError.message : confirmError);
      return new Response('error', { status: 500 });
    }
    if (confirmed) {
      console.log(`yoco webhook confirmed order ${found.number} (event ${eventType || 'unknown'})`);
      return new Response('ok', { status: 200 });
    }
    // The order was settled by a racing path (return handler / status poll) —
    // nothing to retry, accept the delivery.
    console.log(`yoco webhook: order ${found.number} already settled elsewhere (event ${eventType || 'unknown'})`);
    return new Response('ok', { status: 200 });
  } catch (e) {
    // Failures BEFORE positive proof (signature-free lookup, retrieve, amount
    // checks) stay 200 — there is nothing verified to retry and a 500 here
    // would make Yoco hammer us for garbage payloads.
    console.error('yoco webhook error:', e instanceof Error ? e.message : e);
    return new Response('error', { status: 200 });
  }
}
