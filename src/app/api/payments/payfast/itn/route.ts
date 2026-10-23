import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { audit } from '@/lib/audit';
import { settleOrderPayment } from '@/lib/ggpay';
import { payfastEnabled, payfastVerifyItn, payfastItnComplete } from '@/lib/payfast';
import { payfastVerifySellerItn } from '@/lib/seller-payments';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * PayFast ITN (Instant Transaction Notification) — server-to-server webhook.
 *
 * Handles BOTH payment rails with the same verified state transition:
 *  - MARKETPLACE payments (env-driven PayFast, signed with PAYFAST_PASSPHRASE)
 *  - SELLER-owned payments (custom_str2 = "seller:<storeId>", signed with the
 *    seller's own passphrase from their in-app PayFast Onsite setup)
 *
 * Verifies the md5 signature and the reported amount against the real order,
 * then settles through the shared choke-point (settleOrderPayment): the order
 * confirms automatically AND the seller's payout is queued — Payment + Payout
 * rows, notifications, email, audit. Orders are never confirmed by browser
 * traffic — only this verified webhook (or an admin).
 */
export async function POST(req: NextRequest) {
  let verified = false; // flips true only after the signature check passes
  try {
    // Public webhook — keep it cheap to hammer: a modest per-IP ceiling stops
    // brute-force probing of order numbers / signatures without ever slowing
    // a legitimate PayFast retry stream.
    const rl = rateLimit(`payfast-itn:${clientIp(req)}`, 60, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    await bootstrap();

    const raw = await req.text();
    const fields: Record<string, string> = {};
    for (const pair of raw.split('&')) {
      if (!pair) continue;
      const idx = pair.indexOf('=');
      const k = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
      const v = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
      fields[k] = v;
    }

    // Seller-owned payment? custom_str2 = "seller:<storeId>" is set by our
    // own Onsite submission builder — verify with the SELLER's passphrase.
    let sellerMode = false;
    let store: { id: string; name: string; payfastMerchantId: string | null; payfastMerchantKeyEnc: string | null; payfastPassphraseEnc: string | null; } | null = null;
    const marker = String(fields.custom_str2 ?? '');
    if (marker.startsWith('seller:')) {
      sellerMode = true;
      store = await db.store.findUnique({
        where: { id: marker.slice('seller:'.length) },
        select: { id: true, name: true, payfastMerchantId: true, payfastMerchantKeyEnc: true, payfastPassphraseEnc: true },
      });
      if (!store) {
        await audit({ actorEmail: 'payfast-itn', action: 'payfast_itn_rejected', target: fields.m_payment_id ?? null, detail: 'unknown seller store' }).catch(() => undefined);
        return new Response('rejected', { status: 400 });
      }
      const sellerCheck = payfastVerifySellerItn(fields, store);
      if (!sellerCheck.ok) {
        console.error('payfast seller ITN rejected:', sellerCheck.reason);
        await audit({ actorEmail: 'payfast-itn', action: 'payfast_itn_rejected', target: fields.m_payment_id ?? null, detail: `seller: ${sellerCheck.reason}` }).catch(() => undefined);
        return new Response('rejected', { status: 400 });
      }
      // Merchant binding: a correct signature from the SELLER's own passphrase
      // is not enough — the notification must also carry THAT store's merchant
      // id. Without this, a seller account could sign notifications with its
      // own credentials for an order that belongs to a different store.
      if (!store.payfastMerchantId || fields.merchant_id?.trim() !== store.payfastMerchantId.trim()) {
        console.error('payfast seller ITN rejected: merchant id mismatch');
        await audit({ actorEmail: 'payfast-itn', action: 'payfast_itn_rejected', target: fields.m_payment_id ?? null, detail: 'seller: merchant id mismatch' }).catch(() => undefined);
        return new Response('rejected', { status: 400 });
      }
    } else {
      // Marketplace rail — env-gated exactly as before.
      if (!payfastEnabled()) return new Response('payfast not configured', { status: 503 });
      const check = payfastVerifyItn(fields);
      if (!check.ok) {
        console.error('payfast ITN rejected:', check.reason);
        await audit({ actorEmail: 'payfast-itn', action: 'payfast_itn_rejected', target: fields.m_payment_id ?? null, detail: check.reason }).catch(() => undefined);
        return new Response('rejected', { status: 400 });
      }
    }

    // Everything past this point happens AFTER successful verification —
    // failures here are transient (5xx so PayFast retries) rather than
    // permanent rejections.
    verified = true;

    const number = String(fields.m_payment_id ?? '');
    const order = await db.order.findUnique({ where: { number } });
    if (!order) return new Response('unknown order', { status: 200 });

    // Store binding: a seller-owned notification may only confirm an order
    // that BELONGS to that seller's store. Fail closed on anything else.
    if (sellerMode && store && order.storeId !== store.id) {
      await audit({ actorEmail: 'payfast-itn', action: 'payfast_itn_rejected', target: order.number, detail: 'order does not belong to the notified store' }).catch(() => undefined);
      return new Response('rejected', { status: 200 });
    }

    // Amount guard: the paid amount must match the order total exactly
    // (the total already includes The Courier Guy delivery fee).
    const expectedAmount = (order.totalCents / 100).toFixed(2);
    if (Number.isFinite(Number(fields.amount)) && fields.amount !== undefined && fields.amount !== expectedAmount) {
      await audit({ actorEmail: 'payfast-itn', action: 'payfast_itn_amount_mismatch', target: order.number, detail: `${fields.amount} vs ${expectedAmount}` });
      return new Response('amount mismatch', { status: 200 });
    }

    if (!payfastItnComplete(fields)) {
      // CANCELLED / PENDING etc. — no state change; the order stays awaiting.
      return new Response('ignored', { status: 200 });
    }
    if (order.paymentStatus !== 'awaiting_payment') {
      return new Response('already processed', { status: 200 });
    }

    const pfPaymentId = String(fields.pf_payment_id ?? 'unknown');
    const reference = `PAYFAST-${pfPaymentId}`;

    // Shared settlement: order confirmed + Payment row + seller Payout queued,
    // buyer/seller notified — identical to the GGPay in-app card path.
    await settleOrderPayment(
      {
        id: order.id, number: order.number, status: order.status, paymentStatus: order.paymentStatus,
        buyerId: order.buyerId, buyerEmail: order.buyerEmail, storeId: order.storeId,
        subtotalCents: order.subtotalCents, totalCents: order.totalCents,
      },
      { provider: sellerMode ? 'payfast_seller' : 'payfast', method: sellerMode ? 'payfast_onsite' : 'payfast_hosted', reference },
    );
    await audit({ actorEmail: 'payfast-itn', action: 'payment_confirmed_payfast', target: order.number, detail: `ref ${reference}${sellerMode ? ' (seller-owned account)' : ''}` });
    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('payfast ITN error:', e instanceof Error ? e.message : e);
    // Pre-verification rejections are permanent (200 — PayFast must not retry
    // them); post-verification failures are transient (5xx so PayFast retries
    // and a genuinely paid order is never stranded awaiting_payment).
    return new Response('error', { status: verified ? 500 : 200 });
  }
}
