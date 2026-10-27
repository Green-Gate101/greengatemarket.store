import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireStoreSeller, authErrorResponse } from '@/lib/auth';
import { getLabelPdf } from '@/lib/tcg';
import { rateLimit, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * The seller's waybill (label PDF) for a booked The Courier Guy shipment.
 * The TCG API key never leaves the server — the PDF is proxied to the store's
 * owner (or an admin) only, straight from The Courier Guy.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireStoreSeller();
    const rl = rateLimit(`waybill:${session.user.id}`, 30, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const { id } = await ctx.params;

    const store = await db.store.findUnique({ where: { userId: session.user.id }, select: { id: true } });
    if (!store) return Response.json({ error: 'No store found.' }, { status: 404 });

    const order = await db.order.findUnique({
      where: id.startsWith('GG-') ? { number: id } : { id },
      select: { storeId: true, number: true, courierShipmentId: true, courierTrackingRef: true },
    });
    if (!order || (order.storeId !== store.id && session.user.role !== 'ADMIN')) {
      return Response.json({ error: 'Order not found.' }, { status: 404 });
    }
    if (!order.courierShipmentId) {
      return Response.json({ error: 'No courier shipment is booked for this order yet.' }, { status: 409 });
    }

    const label = await getLabelPdf(order.courierShipmentId);
    if (!label.ok) {
      // A missing/stale shipment id falls back to the tracking reference when possible.
      console.error(`waybill fetch failed for ${order.number}: ${label.reason}`);
      return Response.json({ error: `The waybill could not be fetched from The Courier Guy: ${label.reason}` }, { status: 502 });
    }
    return new Response(label.bytes, {
      status: 200,
      headers: {
        'Content-Type': label.contentType.includes('pdf') ? 'application/pdf' : label.contentType,
        'Content-Disposition': `inline; filename="waybill-${order.number}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('waybill error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load the waybill.' }, { status: 500 });
  }
}
