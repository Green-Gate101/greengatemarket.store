import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireRole, authErrorResponse } from '@/lib/auth';
import { canTransition } from '@/lib/payments';
import { audit } from '@/lib/audit';
import { ORDER_STATUS_LABELS, type OrderStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

const SELLER_STATUSES: OrderStatus[] = [
  'confirmed', 'processing', 'packed', 'ready_for_collection', 'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'cancelled', 'returned', 'refunded',
];

/**
 * Fulfilment management for the seller's own order.
 *  - `paymentRef` action: confirm bank-transfer receipt (authenticated server-side, audited).
 *  - `status` action: validated lifecycle transition + OrderEvent history + buyer email.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireRole('SELLER', 'ADMIN');
    const { id } = await ctx.params;
    const store = await db.store.findUnique({ where: { userId: session.user.id } });
    if (!store) return Response.json({ error: 'No store found' }, { status: 404 });

    const order = await db.order.findUnique({ where: id.startsWith('GG-') ? { number: id } : { id } });
    if (!order) return Response.json({ error: 'Order not found.' }, { status: 404 });
    if (order.storeId !== store.id && session.user.role !== 'ADMIN') {
      return Response.json({ error: 'You can only manage orders for your own store.' }, { status: 403 });
    }

    const body = (await req.json()) as { action?: string; status?: string; note?: string };
    const note = String(body.note ?? '').trim() || null;

    if (body.action === 'confirm_payment') {
      if (order.paymentStatus !== 'awaiting_payment') {
        return Response.json({ error: 'Payment for this order has already been processed.' }, { status: 409 });
      }
      const newStatus: OrderStatus = order.status === 'pending_payment' ? 'confirmed' : order.status;
      const updated = await db.$transaction([
        db.order.update({ where: { id: order.id }, data: { paymentStatus: 'paid', status: newStatus, paymentRef: note ?? `EFT-${order.number}` } }),
        db.orderEvent.create({ data: { orderId: order.id, status: newStatus, note: 'Payment received — confirmed by the store', actorId: session.user.id } }),
      ]);
      await notifyBuyer(order.buyerEmail, order.number, newStatus, 'Payment received. Your order is being prepared.');
      await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'payment_confirmed', target: order.number, detail: `amount=${order.totalCents}` });
      return Response.json({ ok: true, order: { status: updated[0].status, paymentStatus: updated[0].paymentStatus } });
    }

    if (body.action === 'status') {
      const next = String(body.status ?? '');
      if (!SELLER_STATUSES.includes(next as OrderStatus)) {
        return Response.json({ error: 'Invalid status.' }, { status: 400 });
      }
      if (!canTransition(order.status, next)) {
        return Response.json({ error: `Cannot move an order from "${ORDER_STATUS_LABELS[order.status as OrderStatus] ?? order.status}" to "${ORDER_STATUS_LABELS[next as OrderStatus] ?? next}".` }, { status: 409 });
      }
      const [updated] = await db.$transaction([
        db.order.update({ where: { id: order.id }, data: { status: next } }),
        db.orderEvent.create({ data: { orderId: order.id, status: next, note, actorId: session.user.id } }),
      ]);
      await notifyBuyer(order.buyerEmail, order.number, next, note);
      await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'order_status_changed', target: order.number, detail: `${order.status} → ${next}` });
      return Response.json({ ok: true, order: { status: updated.status } });
    }

    return Response.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('seller order patch error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not update the order.' }, { status: 500 });
  }
}

async function notifyBuyer(email: string, number: string, status: OrderStatus, note: string | null) {
  const { sendOrderStatusEmail } = await import('@/lib/email');
  void sendOrderStatusEmail({ to: email, orderNumber: number, statusLabel: ORDER_STATUS_LABELS[status] ?? status, note });
}
