import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notify';
import { payfastEnabled, payfastVerifyItn, payfastItnComplete } from '@/lib/payfast';

export const dynamic = 'force-dynamic';

/**
 * PayFast ITN (Instant Transaction Notification) — server-to-server webhook.
 *
 * Verifies the md5 signature (with passphrase) and the reported amount against
 * the real order, then marks the payment received using exactly the same
 * state transition the admin "Confirm payment" action uses. Orders are never
 * confirmed by browser traffic — only this verified webhook (or an admin).
 */
export async function POST(req: NextRequest) {
  try {
    await bootstrap();
    if (!payfastEnabled()) return new Response('payfast not configured', { status: 503 });

    const raw = await req.text();
    const fields: Record<string, string> = {};
    for (const pair of raw.split('&')) {
      if (!pair) continue;
      const idx = pair.indexOf('=');
      const k = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
      const v = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
      fields[k] = v;
    }

    const check = payfastVerifyItn(fields);
    if (!check.ok) {
      console.error('payfast ITN rejected:', check.reason);
      await audit({ actorEmail: 'payfast-itn', action: 'payfast_itn_rejected', target: fields.m_payment_id ?? null, detail: check.reason }).catch(() => undefined);
      return new Response('rejected', { status: 400 });
    }

    const number = String(fields.m_payment_id ?? '');
    const order = await db.order.findUnique({ where: { number } });
    if (!order) return new Response('unknown order', { status: 200 });

    // Amount guard: the paid amount must match the order total exactly.
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
    await db.$transaction([
      db.order.update({
        where: { id: order.id },
        data: { paymentStatus: 'paid', status: order.status === 'pending_payment' ? 'confirmed' : order.status, paymentRef: `PAYFAST-${pfPaymentId}` },
      }),
      db.orderEvent.create({ data: { orderId: order.id, status: 'confirmed', note: `PayFast payment received (ref PAYFAST-${pfPaymentId})` } }),
    ]);

    if (order.buyerId) {
      void notify({
        userId: order.buyerId,
        type: 'payment_confirmed',
        title: 'Payment confirmed',
        body: `Payment for order ${order.number} was received via PayFast. Your order is being prepared.`,
        link: '/orders',
      });
    }
    void (async () => {
      const { sendOrderStatusEmail } = await import('@/lib/email');
      void sendOrderStatusEmail({ to: order.buyerEmail, orderNumber: order.number, statusLabel: 'Payment received via PayFast — order confirmed' });
    })();
    await audit({ actorEmail: 'payfast-itn', action: 'payment_confirmed_payfast', target: order.number, detail: `ref PAYFAST-${pfPaymentId}` });
    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('payfast ITN error:', e instanceof Error ? e.message : e);
    // 200 avoids endless retries on transient app errors; PayFast retries
    // non-200s automatically, which we want only for genuine delivery issues.
    return new Response('error', { status: 200 });
  }
}
