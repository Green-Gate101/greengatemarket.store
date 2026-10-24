import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { decryptSecret } from '@/lib/secret-box';
import { yocoRetrieveCheckout, confirmYocoPayment, yocoKeyUsable, yocoOrdersRedirect } from '@/lib/yoco';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Yoco success landing — the successUrl of every in-system card checkout.
 *
 * IMPORTANT: a redirect from Yoco to this URL is NOT proof of payment (Yoco's
 * own guidance is to confirm the outcome server-side). This handler therefore
 * re-retrieves the checkout session with the seller's key and confirms the
 * order only on positive proof of payment. If the outcome cannot yet be
 * verified, the buyer is returned to their orders with a `pending` flag and
 * the order simply stays awaiting_payment — the seller's manual confirm and
 * the payment.succeeded webhook both still work.
 */
export async function GET(req: NextRequest) {
  try {
    // Public landing (every buyer's Yoco redirect) that may fire a signed
    // outbound Yoco lookup — keep a sane per-IP ceiling on it.
    const rl = rateLimit(`yoco-return:${clientIp(req)}`, 60, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    await bootstrap();
    const base = (process.env.NEXTAUTH_URL ?? req.nextUrl.origin).replace(/\/$/, '');
    const number = req.nextUrl.searchParams.get('number') ?? '';
    if (!/^[A-Z0-9-]{4,32}$/.test(number)) {
      return NextResponse.redirect(yocoOrdersRedirect(base, 'pending'));
    }

    const order = await db.order.findUnique({
      where: { number },
      select: {
        id: true, number: true, status: true, paymentStatus: true, buyerId: true, buyerEmail: true,
        paymentRef: true, yocoCheckoutId: true, totalCents: true,
        store: { select: { yocoSecretKey: true } },
      },
    });
    if (!order) return NextResponse.redirect(yocoOrdersRedirect(base, 'pending'));

    if (order.paymentStatus === 'awaiting_payment' && order.yocoCheckoutId && order.store.yocoSecretKey) {
      const secret = decryptSecret(order.store.yocoSecretKey);
      // A test key never confirms a live order (no money moved).
      const checkout = secret && yocoKeyUsable(secret) ? await yocoRetrieveCheckout(secret, order.yocoCheckoutId) : null;
      // Amount binding mirrors the webhook: only a checkout for the EXACT
      // order total counts as proof (fail closed when Yoco reports none).
      if (checkout?.paid && checkout.amountCents === order.totalCents) {
        const ref = `YOCO-${order.yocoCheckoutId}`;
        await confirmYocoPayment(order, ref);
        return NextResponse.redirect(yocoOrdersRedirect(base, 'success'));
      }
    }

    // Paid earlier (idempotent return) or not yet verifiable.
    if (order.paymentStatus === 'paid') return NextResponse.redirect(yocoOrdersRedirect(base, 'success'));
    return NextResponse.redirect(yocoOrdersRedirect(base, 'pending'));
  } catch (e) {
    console.error('yoco return error:', e instanceof Error ? e.message : e);
    return NextResponse.redirect(`${(process.env.NEXTAUTH_URL ?? req.nextUrl.origin).replace(/\/$/, '')}/#/orders?yoco=pending`);
  }
}
