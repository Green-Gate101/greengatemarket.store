import { NextRequest } from 'next/server';
import { timingSafeEqual } from 'crypto';
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
const EXPIRY_BATCH = 200;

/** Days an order may stay unpaid before it is cancelled and its stock freed
 *  (UNPAID_ORDER_CANCEL_DAYS, default 7; 0 switches expiry off). */
function unpaidCancelDays(): number {
  const raw = Number(process.env.UNPAID_ORDER_CANCEL_DAYS ?? '7');
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 7;
}

/**
 * Unpaid-order expiry: checkout reserves stock, so an order nobody pays for
 * used to hold it forever (listings showed "sold out" for goods still on the
 * shelf). Two days before the deadline the buyer gets one warning; at the
 * deadline the order is cancelled atomically (only if STILL unpaid — a
 * payment that lands first always wins), the stock is restored in the same
 * transaction, and buyer + seller are told. Idempotent: guard events and the
 * conditional status claim make retries harmless.
 */
async function expireUnpaidOrders(baseUrl: string): Promise<{ expiryWarned: number; expired: number }> {
  const days = unpaidCancelDays();
  if (days === 0) return { expiryWarned: 0, expired: 0 };
  const now = Date.now();
  // Stay inside the 60s function limit; leftovers are handled next run.
  const deadline = now + 40_000;
  let expiryWarned = 0;
  let expired = 0;
  const { sendOrderStatusEmail } = await import('@/lib/email');
  const { restockOrderItems } = await import('@/lib/inventory');

  // 1. Warning — due within 2 days, not yet warned.
  if (days > 2) {
    const warnCutoff = new Date(now - (days - 2) * 86400_000);
    const toWarn = await db.order.findMany({
      where: { status: 'pending_payment', paymentStatus: 'awaiting_payment', createdAt: { lt: warnCutoff }, events: { none: { status: 'expiry_warning' } } },
      orderBy: { createdAt: 'asc' },
      take: EXPIRY_BATCH,
      select: { id: true, number: true, buyerId: true, buyerEmail: true, totalCents: true },
    });
    for (const o of toWarn) {
      if (Date.now() > deadline) break;
      await db.orderEvent.create({ data: { orderId: o.id, status: 'expiry_warning', note: `Unpaid — will be cancelled automatically in about 2 days if no payment arrives` } });
      if (o.buyerId) {
        void notify({ userId: o.buyerId, type: 'order_status', title: 'Order will be cancelled soon', body: `Order ${o.number} (${formatMoney(o.totalCents)}) is still unpaid and will be cancelled in about 2 days. Pay from My orders to keep it.`, link: '/orders' });
      }
      if (emailConfigured) {
        await sendOrderStatusEmail({ to: o.buyerEmail, orderNumber: o.number, statusLabel: 'Unpaid — cancels in about 2 days', note: `Pay from My orders (${baseUrl}/#/orders) to keep this order.` }).catch(() => false);
      }
      expiryWarned += 1;
    }
  }

  // 2. Expiry — past the deadline and still unpaid.
  const cutoff = new Date(now - days * 86400_000);
  const due = await db.order.findMany({
    where: { status: 'pending_payment', paymentStatus: 'awaiting_payment', createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: EXPIRY_BATCH,
    select: { id: true, number: true, buyerId: true, buyerEmail: true, totalCents: true, store: { select: { name: true, userId: true } } },
  });
  for (const o of due) {
    if (Date.now() > deadline) break;
    const cancelled = await db.$transaction(async (tx) => {
      const claim = await tx.order.updateMany({
        where: { id: o.id, status: 'pending_payment', paymentStatus: 'awaiting_payment' },
        data: { status: 'cancelled' },
      });
      if (claim.count === 0) return false; // paid or changed meanwhile — leave it
      await tx.orderEvent.create({ data: { orderId: o.id, status: 'cancelled', note: `Cancelled automatically — no payment within ${days} days; reserved stock returned` } });
      await restockOrderItems(tx, o.id);
      return true;
    });
    if (!cancelled) continue;
    expired += 1;
    if (o.buyerId) {
      void notify({ userId: o.buyerId, type: 'order_status', title: 'Order cancelled — not paid', body: `Order ${o.number} was cancelled because no payment arrived within ${days} days. If you did pay, contact ${o.store.name} with your PayFast, Ozow or Yoco receipt.`, link: '/orders' });
    }
    if (o.store.userId) {
      void notify({ userId: o.store.userId, type: 'order_status', title: 'Unpaid order cancelled', body: `Order ${o.number} was cancelled after ${days} days without payment and its stock returned to your listings. If the buyer shows a PayFast, Ozow or Yoco receipt for it, refund them through your payment provider.`, link: '/dashboard' });
    }
    if (emailConfigured) {
      await sendOrderStatusEmail({ to: o.buyerEmail, orderNumber: o.number, statusLabel: 'Cancelled — not paid', note: `No payment arrived within ${days} days. If you did pay, contact ${o.store.name} with your PayFast, Ozow or Yoco receipt.` }).catch(() => false);
    }
    await audit({ actorId: null, actorEmail: 'cron@system', action: 'unpaid_order_expired', target: o.number, detail: `${formatMoney(o.totalCents)} · ${o.store.name} · ${days}d` });
  }
  return { expiryWarned, expired };
}

export async function GET(req: NextRequest) {
  const started = Date.now();
  try {
    const secret = process.env.CRON_SECRET;
    // Fail closed on any Vercel deployment (prod AND preview — both share the
    // production database): an unauthenticated cron endpoint would let anyone
    // fire buyer reminder emails, unpaid-order expiry and subscription
    // housekeeping at will. Local dev (no VERCEL_ENV) stays open for testing.
    if (process.env.VERCEL_ENV && !secret) {
      return Response.json({ error: 'Cron is not configured on this deployment (CRON_SECRET missing).' }, { status: 503 });
    }
    if (secret) {
      const auth = req.headers.get('authorization') ?? '';
      const expected = `Bearer ${secret}`;
      const same = auth.length === expected.length && timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
      if (!same) {
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

      // The orders view IS the payment page in this app (hash-routed SPA —
      // there is no /checkout/pay route): link buyers where their order's
      // in-app payment panel actually lives.
      const payUrl = `${baseUrl}/#/orders`;
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
          link: '/orders',
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

    const expiry = await expireUnpaidOrders(baseUrl);
    // Seller subscriptions ride along on this daily job (the Hobby plan allows
    // only two cron jobs): confirm pending payments with Yoco, close abandoned
    // checkouts, remind 3 days before access ends, notify once when it lapses.
    let subscriptions: Record<string, number> | { error: string } = {};
    try {
      const { runSubscriptionHousekeeping } = await import('@/lib/subscription');
      subscriptions = await runSubscriptionHousekeeping();
    } catch (e) {
      console.error('subscription housekeeping failed:', e instanceof Error ? e.message : e);
      subscriptions = { error: 'subscription housekeeping failed' };
    }
    // Product events older than PRODUCT_EVENT_KEEP_DAYS are deleted (a view is
    // one row per visit). Runs last, only with the time left inside the 60 s
    // limit, so it never crowds out the jobs above; a backlog finishes over
    // the next days.
    let retention: { deleted: number; done: boolean } | { skipped: string } | { error: string };
    const timeLeft = started + 55_000 - Date.now();
    if (timeLeft < 3_000) {
      retention = { skipped: 'no time left in this run — continues tomorrow' };
    } else {
      try {
        const { pruneOldProductEvents } = await import('@/lib/retention');
        retention = await pruneOldProductEvents(Math.min(20_000, timeLeft));
      } catch (e) {
        console.error('product event clean-up failed:', e instanceof Error ? e.message : e);
        retention = { error: 'product event clean-up failed' };
      }
    }
    // Courier bookings that failed earlier (empty TCG wallet, network blip)
    // get their daily retry here, on top of the seller-dashboard sweeps.
    let courier: { attempted: number; booked: number } | { error: string };
    try {
      const { sweepPendingBookings } = await import('@/lib/courier-booking');
      courier = await sweepPendingBookings({ limit: 5 });
    } catch (e) {
      console.error('courier booking sweep failed:', e instanceof Error ? e.message : e);
      courier = { error: 'courier booking sweep failed' };
    }
    return Response.json({ ok: true, checked: candidates.length, reminded, skipped, ...expiry, subscriptions, retention, courier });
  } catch (e) {
    console.error('abandoned-checkouts cron error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Recovery pass failed.' }, { status: 500 });
  }
}
