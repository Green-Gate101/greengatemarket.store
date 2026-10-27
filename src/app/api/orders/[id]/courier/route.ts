import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { getTracking, getShipmentStatus } from '@/lib/tcg';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Buyer-facing courier tracking for one order. The buyer can only see their
 * own order (an admin can see any). Returns the stored booking state plus —
 * when a tracking reference exists — live events straight from The Courier
 * Guy. The human order number (GG-XXXX) is accepted as the id for deep links.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await bootstrap();
    const session = await requireUser();
    const rl = rateLimit(`courier-view:${clientIp(req)}`, 60, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const { id } = await ctx.params;

    const order = await db.order.findUnique({
      where: id.startsWith('GG-') ? { number: id } : { id },
      select: {
        id: true, number: true, buyerId: true, status: true, paymentStatus: true,
        courierTrackingRef: true, courierShipmentId: true, courierStatus: true, courierBookedAt: true,
      },
    });
    if (!order) return Response.json({ error: 'Order not found.' }, { status: 404 });
    if (order.buyerId !== session.user.id && session.user.role !== 'ADMIN') {
      // Never reveal that someone else's order number exists.
      return Response.json({ error: 'Order not found.' }, { status: 404 });
    }

    const base = {
      number: order.number,
      status: order.status,
      paymentStatus: order.paymentStatus,
      courierStatus: order.courierStatus,
      courierBookedAt: order.courierBookedAt,
      trackingRef: order.courierTrackingRef,
    };

    if (!order.courierTrackingRef) {
      return Response.json({ ...base, events: [] });
    }
    const [tracking, status] = await Promise.all([
      getTracking(order.courierTrackingRef),
      getShipmentStatus(order.courierTrackingRef).catch(() => ({ ok: false as const, reason: 'unavailable' })),
    ]);
    return Response.json({
      ...base,
      courierLiveStatus: status.ok ? status.status : null,
      events: tracking.ok ? tracking.events : [],
      trackingError: tracking.ok ? null : tracking.reason,
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('courier view error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load courier tracking.' }, { status: 500 });
  }
}
