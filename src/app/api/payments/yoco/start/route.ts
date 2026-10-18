import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { decryptSecret } from '@/lib/secret-box';
import { yocoCreateCheckout, yocoOrdersRedirect } from '@/lib/yoco';

export const dynamic = 'force-dynamic';

/**
 * Start (or restart) the in-system Yoco card checkout for an order the caller
 * owns. Used by the buyer's order views for orders that still await payment —
 * the marketplace creates a fresh Yoco session for the exact order total and
 * 302s the buyer straight to Yoco's hosted card page (Mastercard & Visa).
 *
 * Failure is graceful: the buyer is redirected back to their orders with a
 * `yoco=unavailable` flag and the usual bank-transfer / payment-link options
 * remain available. Payment success is never decided here — only by the
 * verified return handler / webhook.
 */
export async function GET(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireUser();

    const number = new URL(req.url).searchParams.get('number') ?? '';
    if (!/^[A-Z0-9-]{4,32}$/.test(number)) {
      return NextResponse.redirect(yocoOrdersRedirect(baseUrl(req), 'unavailable'));
    }

    const order = await db.order.findUnique({
      where: { number },
      select: {
        id: true, number: true, buyerId: true, paymentStatus: true, totalCents: true, yocoCheckoutId: true,
        store: { select: { name: true, payoutProvider: true, yocoSecretKey: true } },
      },
    });
    if (!order || order.buyerId !== session.user.id) {
      return NextResponse.redirect(yocoOrdersRedirect(baseUrl(req), 'unavailable'));
    }
    if (order.paymentStatus !== 'awaiting_payment') {
      return NextResponse.redirect(yocoOrdersRedirect(baseUrl(req), 'pending'));
    }
    if (!['yoco', 'mastercard'].includes(order.store.payoutProvider ?? '') || !order.store.yocoSecretKey) {
      return NextResponse.redirect(yocoOrdersRedirect(baseUrl(req), 'unavailable'));
    }
    const secret = decryptSecret(order.store.yocoSecretKey);
    if (!secret) return NextResponse.redirect(yocoOrdersRedirect(baseUrl(req), 'unavailable'));

    const sessionUrl = await yocoCreateCheckout(secret, {
      amountCents: order.totalCents,
      orderNumber: order.number,
      storeName: order.store.name,
      successUrl: `${baseUrl(req)}/api/payments/yoco/return?number=${encodeURIComponent(order.number)}`,
      cancelUrl: yocoOrdersRedirect(baseUrl(req), 'cancelled'),
    });
    if (!sessionUrl) return NextResponse.redirect(yocoOrdersRedirect(baseUrl(req), 'unavailable'));

    await db.order.update({ where: { id: order.id }, data: { yocoCheckoutId: sessionUrl.id } });
    return NextResponse.redirect(sessionUrl.redirectUrl);
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('yoco start error:', e instanceof Error ? e.message : e);
    return NextResponse.redirect(yocoOrdersRedirect(req.nextUrl.origin, 'unavailable'));
  }
}

/** Canonical base URL for redirects (env first — deploy-preview origins differ). */
function baseUrl(req: NextRequest): string {
  return (process.env.NEXTAUTH_URL ?? req.nextUrl.origin).replace(/\/$/, '');
}
