import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { decryptSecret } from '@/lib/secret-box';
import { yocoRetrieveCheckout, confirmYocoPayment, yocoOrdersRedirect } from '@/lib/yoco';

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
        paymentRef: true, yocoCheckoutId: true,
        store: { select: { yocoSecretKey: true } },
      },
    });
    if (!order) return NextResponse.redirect(yocoOrdersRedirect(base, 'pending'));

    if (order.paymentStatus === 'awaiting_payment' && order.yocoCheckoutId && order.store.yocoSecretKey) {
      const secret = decryptSecret(order.store.yocoSecretKey);
      const checkout = secret ? await yocoRetrieveCheckout(secret, order.yocoCheckoutId) : null;
      if (checkout?.paid) {
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
