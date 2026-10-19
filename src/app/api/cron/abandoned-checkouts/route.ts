import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { audit } from '@/lib/audit';
import { formatMoney } from '@/lib/types';
import { notify } from '@/lib/notify';
import { emailConfigured, sendAbandonedCheckoutEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Abandoned-checkout recovery (additive — nothing existing changes).
 *
 * Vercel Cron hits this route on a schedule (vercel.json crons). It finds
 * orders that were PLACED but never PAID for at least two hours and sends
 * exactly ONE gentle in-app + email reminder per order with a direct link to
 * the order's in-app payment page. Idempotent by construction: the reminder
 * is recorded as an OrderEvent('recovery_sent') in the same pass, so a cron
 * retry can never double-send.
 *
 * Auth: when CRON_SECRET is configured (production), Vercel Cron calls carry
 * `Authorization: Bearer <CRON_SECRET>` and anything else is rejected. When
 * it is not configured (local development) the route is open so the flow can
 * still be exercised end-to-end.
 */

const MIN_AGE_MS = 2 * 60 * 60_000; // 2 hours after checkout
const BATCH = 50;

export async function GET(req: NextRequest) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers.get('authorization') ?? '';
      if (auth !== `Bearer ${secret}`) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
    await bootstrap();

    const cutoff = new Date(Date.now() - MIN_AGE_MS);
    const candidates = await db.order.findMany({
      where: {
        status: 'pending_payment',
        paymentStatus: 'awaiting_payment',
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
      select: {
        id: true, number: true, buyerEmail: true, buyerName: true, buyerId: true,
        totalCents: true, createdAt: true,
        store: { select: { name: true } },
        events: { where: { status: 'recovery_sent' }, select: { id: true }, take: 1 },
      },
    });

    const baseUrl = (process.env.NEXTAUTH_URL ?? new URL(req.url).origin).replace(/\/$/, '');
    let reminded = 0;
    let skipped = 0;

    for (const order of candidates) {
      // Exactly-once guard: skip orders that already received their reminder.
      if (order.events.length > 0) {
        skipped += 1;
        continue;
      }

      const payUrl = `${baseUrl}/checkout/pay/${order.id}`;
      const hoursAgo = Math.round((Date.now() - order.createdAt.getTime()) / 3600_000);

      // Email first (best-effort, never blocks the guard), then the guard
      // event, then the in-app notification — so no path can double-send.
      if (emailConfigured) {
        await sendAbandonedCheckoutEmail({
          to: order.buyerEmail,
          buyerName: order.buyerName,
          orderNumber: order.number,
          storeName: order.store.name,
          total: formatMoney(order.totalCents),
          payUrl,
        }).catch(() => false);
      }

      await db.orderEvent.create({
        data: {
          orderId: order.id,
          status: 'recovery_sent',
          note: `Abandoned-checkout reminder sent (~${hoursAgo}h after checkout)${emailConfigured ? ' — email + in-app' : ' — in-app only (email not configured)'}`,
        },
      });

      if (order.buyerId) {
        void notify({
          userId: order.buyerId,
          type: 'order_status',
          title: 'Complete your payment',
          body: `Order ${order.number} (${formatMoney(order.totalCents)}) is waiting — your items are reserved. Pay securely in the app to confirm it.`,
          link: `/checkout/pay/${order.id}`,
        });
      }

      await audit({
        actorId: null,
        actorEmail: 'cron@system',
        action: 'abandoned_checkout_reminder',
        target: order.number,
        detail: `${formatMoney(order.totalCents)} · ${order.store.name} · ~${hoursAgo}h`,
      });

      reminded += 1;
    }

    return Response.json({ ok: true, checked: candidates.length, reminded, skipped });
  } catch (e) {
    console.error('abandoned-checkouts cron error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Recovery pass failed.' }, { status: 500 });
  }
}
