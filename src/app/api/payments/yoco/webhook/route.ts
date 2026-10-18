import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { decryptSecret } from '@/lib/secret-box';
import { yocoRetrieveCheckout, confirmYocoPayment } from '@/lib/yoco';

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
    const order = checkoutId
      ? await db.order.findFirst({ where: { yocoCheckoutId: checkoutId }, select: { id: true, number: true, status: true, paymentStatus: true, buyerId: true, buyerEmail: true, paymentRef: true, yocoCheckoutId: true, store: { select: { yocoSecretKey: true } } } })
      : null;
    const found = order ?? (transactionId
      ? await db.order.findUnique({ where: { number: transactionId }, select: { id: true, number: true, status: true, paymentStatus: true, buyerId: true, buyerEmail: true, paymentRef: true, yocoCheckoutId: true, store: { select: { yocoSecretKey: true } } } })
      : null);
    if (!found) return new Response('ok', { status: 200 });
    if (found.paymentStatus !== 'awaiting_payment') return new Response('ok', { status: 200 });

    const lookupId = found.yocoCheckoutId ?? (checkoutId || null);
    const secret = found.store.yocoSecretKey ? decryptSecret(found.store.yocoSecretKey) : null;
    const checkout = lookupId && secret ? await yocoRetrieveCheckout(secret, lookupId) : null;
    if (!checkout?.paid) return new Response('ok', { status: 200 });

    const ref = `YOCO-${lookupId ?? found.number}`;
    await confirmYocoPayment(found, ref);
    console.log(`yoco webhook confirmed order ${found.number} (event ${eventType || 'unknown'})`);
    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('yoco webhook error:', e instanceof Error ? e.message : e);
    return new Response('error', { status: 200 });
  }
}
