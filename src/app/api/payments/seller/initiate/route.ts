import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { audit } from '@/lib/audit';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';
import {
  ozowCreateTransaction, ozowSellerReady, payfastOnsiteSubmission, payfastSellerReady,
} from '@/lib/seller-payments';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Start an IN-APP payment for an order the caller owns, using the SELLER'S
 * OWN payment processor (PayFast Onsite or Ozow instant EFT).
 *
 *  - method "payfast" → a signed Onsite submission the buyer completes inside
 *    an in-app lightbox frame (card or SiD instant EFT). The amount is the
 *    full order total including The Courier Guy delivery.
 *  - method "ozow"    → a server-created Ozow transaction whose bank
 *    selection runs inside an in-app frame (instant EFT, no redirect away).
 *
 * Nothing here trusts the browser for success — the order only confirms via
 * the verified ITN / notify webhooks (or the authenticated status query).
 * On any processor failure the response says so honestly and the UI falls
 * back to the remaining rails (Yoco card → GGPay card → link → bank transfer).
 */
export async function POST(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireUser();
    const rl = rateLimit(`sellerpay:${session.user.id}:${clientIp(req)}`, 20, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const body = (await req.json()) as { orderNumber?: string; method?: string };
    const orderNumber = String(body.orderNumber ?? '').trim();
    const method = String(body.method ?? '').trim().toLowerCase();
    if (!orderNumber || !['payfast', 'ozow'].includes(method)) {
      return Response.json({ error: 'Specify an order number and method (payfast or ozow).' }, { status: 400 });
    }

    const order = await db.order.findFirst({
      where: { number: orderNumber, OR: [{ buyerId: session.user.id }, { buyerEmail: session.user.email }] },
      select: {
        id: true, number: true, buyerEmail: true, buyerName: true, totalCents: true, paymentStatus: true, ozowTransactionId: true,
        store: {
          select: {
            id: true, name: true,
            payfastMerchantId: true, payfastMerchantKeyEnc: true, payfastPassphraseEnc: true,
            ozowSiteCode: true, ozowPrivateKeyEnc: true, ozowApiKeyEnc: true,
          },
        },
      },
    });
    if (!order) return Response.json({ error: 'Order not found.' }, { status: 404 });
    if (order.paymentStatus !== 'awaiting_payment') {
      return Response.json({ error: 'This order is not awaiting payment.' }, { status: 409 });
    }

    const origin = (process.env.NEXTAUTH_URL ?? new URL(req.url).origin).replace(/\/$/, '');
    const sellerOrder = {
      id: order.id, number: order.number, totalCents: order.totalCents,
      buyerEmail: order.buyerEmail, buyerName: order.buyerName,
    };

    if (method === 'payfast') {
      if (!order.store || !payfastSellerReady(order.store)) {
        return Response.json({ error: 'This seller has no PayFast account connected. Choose another payment method.' }, { status: 400 });
      }
      const onsite = payfastOnsiteSubmission(sellerOrder, order.store, origin);
      if (!onsite) {
        await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'seller_payfast_initiate_failed', target: order.number, detail: 'submission build failed' }).catch(() => undefined);
        return Response.json({ error: 'PayFast could not be started. Please try another payment method.' }, { status: 502 });
      }
      return Response.json({
        ok: true,
        kind: 'payfast_onsite',
        method: 'payfast',
        orderNumber: order.number,
        amountCents: order.totalCents,
        submission: onsite.submission,
        processUrl: onsite.processUrl,
        sandbox: onsite.sandbox,
      });
    }

    // method === 'ozow'
    if (!order.store || !ozowSellerReady(order.store)) {
      return Response.json({ error: 'This seller has no Ozow account connected. Choose another payment method.' }, { status: 400 });
    }
    const tx = await ozowCreateTransaction(sellerOrder, order.store, origin);
    if (!tx) {
      await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'seller_ozow_initiate_failed', target: order.number, detail: 'transaction create failed' }).catch(() => undefined);
      return Response.json({ error: 'Ozow could not be started right now. Please try again or use another payment method.' }, { status: 502 });
    }
    if (order.ozowTransactionId !== tx.transactionId) {
      await db.order.update({ where: { id: order.id }, data: { ozowTransactionId: tx.transactionId } });
    }
    return Response.json({
      ok: true,
      kind: 'ozow_frame',
      method: 'ozow',
      orderNumber: order.number,
      amountCents: order.totalCents,
      paymentUrl: tx.paymentUrl,
      transactionId: tx.transactionId,
      isTest: tx.isTest,
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('seller initiate error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Payment could not be started. Please try again.' }, { status: 500 });
  }
}
