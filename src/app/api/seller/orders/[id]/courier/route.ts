import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireStoreSeller, authErrorResponse } from '@/lib/auth';
import { bookShipmentForOrder, sweepPendingBookings } from '@/lib/courier-booking';
import { getTracking } from '@/lib/tcg';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';
import { rateLimit, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * The seller's courier control for one of their own orders.
 *  - POST: book (or re-book) the The Courier Guy collection. Automatic right
 *    after payment; this manual trigger covers failures (e.g. the TCG wallet
 *    was empty) — "Book courier" in the dashboard.
 *  - GET: booking state + live tracking events for the order.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireStoreSeller();
    const rl = rateLimit(`courier-book:${session.user.id}`, 30, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const body = await readJsonObject(req).catch(() => null);
    if (body === null && (req.headers.get('content-length') ?? '0') !== '0') return invalidJsonBody();
    const { id } = await ctx.params;
    const store = await db.store.findUnique({ where: { userId: session.user.id }, select: { id: true } });
    if (!store) return Response.json({ error: 'No store found.' }, { status: 404 });

    const order = await db.order.findUnique({
      where: id.startsWith('GG-') ? { number: id } : { id },
      select: { id: true, storeId: true, courierTrackingRef: true },
    });
    if (!order || order.storeId !== store.id) return Response.json({ error: 'Order not found.' }, { status: 404 });

    const result = await bookShipmentForOrder(order.id, { force: true });
    if (!result.ok) {
      return Response.json(
        { error: `The Courier Guy could not book this collection: ${result.reason}${result.skipped ? '' : ' — your items can still ship while this retries.'}` },
        { status: result.skipped ? 409 : 502 },
      );
    }
    return Response.json({ ok: true, trackingRef: result.trackingReference });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('courier book error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not book the courier.' }, { status: 500 });
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireStoreSeller();
    const { id } = await ctx.params;
    const store = await db.store.findUnique({ where: { userId: session.user.id }, select: { id: true } });
    if (!store) return Response.json({ error: 'No store found.' }, { status: 404 });

    const order = await db.order.findUnique({
      where: id.startsWith('GG-') ? { number: id } : { id },
      select: {
        storeId: true, number: true, status: true, paymentStatus: true,
        courierTrackingRef: true, courierShipmentId: true, courierStatus: true, courierBookedAt: true,
      },
    });
    if (!order || order.storeId !== store.id) return Response.json({ error: 'Order not found.' }, { status: 404 });

    const base = {
      number: order.number,
      status: order.status,
      paymentStatus: order.paymentStatus,
      courierStatus: order.courierStatus,
      courierBookedAt: order.courierBookedAt,
      trackingRef: order.courierTrackingRef,
      shipmentId: order.courierShipmentId,
    };
    if (!order.courierTrackingRef) {
      // A dashboard load is also the passive retry for failed bookings.
      void sweepPendingBookings({ storeId: store.id, limit: 3 }).catch(() => undefined);
      return Response.json({ ...base, events: [] });
    }
    const tracking = await getTracking(order.courierTrackingRef);
    return Response.json({ ...base, events: tracking.ok ? tracking.events : [], trackingError: tracking.ok ? null : tracking.reason });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('courier seller view error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load courier information.' }, { status: 500 });
  }
}
