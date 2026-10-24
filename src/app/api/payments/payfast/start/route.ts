import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { payfastEnabled, payfastPaymentForm, payfastRedirectPage } from '@/lib/payfast';
import { rateLimitShared } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Start the MARKETPLACE PayFast hosted payment for an order the caller owns.
 * The order views link here ("Or pay with PayFast") whenever the marketplace
 * PayFast rail is configured — this route was missing, so that link 404'd.
 *
 * It only builds the signed payment form (src/lib/payfast.ts) for the exact order
 * total; payment success is decided solely by the verified ITN webhook. Any
 * problem returns the buyer to their orders with `payfast=unavailable`, and
 * the other payment options stay available.
 */
export async function GET(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireUser();

    const rl = await rateLimitShared(`payfast-start:${session.user.id}`, 20, 3600_000);
    if (!rl.allowed) return NextResponse.redirect(ordersRedirect(req, 'unavailable'));
    if (!payfastEnabled()) return NextResponse.redirect(ordersRedirect(req, 'unavailable'));

    const number = new URL(req.url).searchParams.get('number') ?? '';
    if (!/^[A-Z0-9-]{4,32}$/.test(number)) return NextResponse.redirect(ordersRedirect(req, 'unavailable'));

    const order = await db.order.findFirst({
      where: { number, OR: [{ buyerId: session.user.id }, { buyerEmail: session.user.email }] },
      select: { id: true, number: true, totalCents: true, currency: true, buyerEmail: true, buyerName: true, status: true, paymentStatus: true },
    });
    if (!order || order.status === 'cancelled' || order.status === 'refunded') {
      return NextResponse.redirect(ordersRedirect(req, 'unavailable'));
    }
    if (order.paymentStatus !== 'awaiting_payment') return NextResponse.redirect(ordersRedirect(req, 'pending'));

    // PayFast's payment page takes a signed POST (top-level — it must not be
    // framed), so the buyer gets an auto-submitting form.
    const form = payfastPaymentForm({
      number: order.number,
      id: order.id,
      totalCents: order.totalCents,
      currency: order.currency,
      buyerEmail: order.buyerEmail,
      buyerName: order.buyerName,
      origin: baseUrl(req),
    });
    return new Response(payfastRedirectPage(form.processUrl, form.fields), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('payfast start error:', e instanceof Error ? e.message : e);
    return NextResponse.redirect(ordersRedirect(req, 'unavailable'));
  }
}

/** Canonical base URL for redirects (env first — deploy-preview origins differ). */
function baseUrl(req: NextRequest): string {
  return (process.env.NEXTAUTH_URL ?? req.nextUrl.origin).replace(/\/$/, '');
}

function ordersRedirect(req: NextRequest, state: 'pending' | 'unavailable'): string {
  return `${baseUrl(req)}/#/orders?payfast=${state}`;
}
