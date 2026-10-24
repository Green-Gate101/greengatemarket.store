import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireStoreSeller, authErrorResponse } from '@/lib/auth';
import { canTransition } from '@/lib/payments';
import { audit } from '@/lib/audit';
import { ORDER_STATUS_LABELS, type OrderStatus } from '@/lib/types';
import { notify } from '@/lib/notify';
import { restockOrderItems } from '@/lib/inventory';

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
    const session = await requireStoreSeller();
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
      if (order.status === 'cancelled' || order.status === 'refunded') {
        return Response.json({ error: 'This order was cancelled — its payment can no longer be confirmed.' }, { status: 409 });
      }
      const newStatus: OrderStatus = order.status === 'pending_payment' ? 'confirmed' : (order.status as OrderStatus);
      // Atomic claim (same rule as the admin confirm and settleOrderPayment):
      // concurrent confirms cannot both win, and a cancelled order is never paid.
      const claimed = await db.$transaction(async (tx) => {
        const claim = await tx.order.updateMany({
          where: { id: order.id, paymentStatus: 'awaiting_payment', status: { notIn: ['cancelled', 'refunded'] } },
          data: { paymentStatus: 'paid', status: newStatus, paymentRef: note ?? `EFT-${order.number}` },
        });
        if (claim.count === 0) return false;
        await tx.orderEvent.create({ data: { orderId: order.id, status: newStatus, note: 'Payment received — confirmed by the store', actorId: session.user.id } });
        return true;
      });
      if (!claimed) {
        return Response.json({ error: 'Payment for this order has already been processed.' }, { status: 409 });
      }
      await notifyBuyer(order.buyerId, order.buyerEmail, order.number, newStatus, 'Payment received. Your order is being prepared.');
      await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'payment_confirmed', target: order.number, detail: `amount=${order.totalCents}` });
      return Response.json({ ok: true, order: { status: newStatus, paymentStatus: 'paid' } });
    }

    if (body.action === 'status') {
      const next = String(body.status ?? '');
      if (!SELLER_STATUSES.includes(next as OrderStatus)) {
        return Response.json({ error: 'Invalid status.' }, { status: 400 });
      }
      if (!canTransition(order.status, next)) {
        return Response.json({ error: `Cannot move an order from "${ORDER_STATUS_LABELS[order.status as OrderStatus] ?? order.status}" to "${ORDER_STATUS_LABELS[next as OrderStatus] ?? next}".` }, { status: 409 });
      }
      // The previous status lives in the WHERE so two concurrent updates can
      // never both apply. Cancellation (only possible before dispatch) puts
      // the reserved stock back — checkout decremented it, and without this
      // cancelled units stayed "sold" forever.
      const moved = await db.$transaction(async (tx) => {
        const claim = await tx.order.updateMany({ where: { id: order.id, status: order.status }, data: { status: next } });
        if (claim.count === 0) return false;
        await tx.orderEvent.create({ data: { orderId: order.id, status: next, note, actorId: session.user.id } });
        if (next === 'cancelled') await restockOrderItems(tx, order.id);
        return true;
      });
      if (!moved) {
        return Response.json({ error: 'This order was just updated elsewhere — refresh and try again.' }, { status: 409 });
      }
      await notifyBuyer(order.buyerId, order.buyerEmail, order.number, next as OrderStatus, note);
      await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'order_status_changed', target: order.number, detail: `${order.status} → ${next}${next === 'cancelled' ? ' · stock restored' : ''}` });
      return Response.json({ ok: true, order: { status: next } });
    }

    return Response.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('seller order patch error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not update the order.' }, { status: 500 });
  }
}

/** Buyer order updates: transactional email plus a persistent in-app notification. */
async function notifyBuyer(buyerId: string | null, email: string, number: string, status: OrderStatus, note: string | null) {
  const { sendOrderStatusEmail } = await import('@/lib/email');
  const label = ORDER_STATUS_LABELS[status] ?? status;
  void sendOrderStatusEmail({ to: email, orderNumber: number, statusLabel: label, note });
  if (!buyerId) return;
  if (status === 'confirmed') {
    void notify({
      userId: buyerId,
      type: 'payment_confirmed',
      title: 'Payment confirmed',
      body: `Payment for order ${number} was received. Your order is being prepared.`,
      link: '/orders',
    });
  } else {
    void notify({
      userId: buyerId,
      type: 'order_status',
      title: `Order update: ${label}`,
      body: `Order ${number} is now ${label}.${note ? ` Note from the store: ${note}` : ''}`,
      link: '/orders',
    });
  }
}
