import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { rateLimitShared, tooManyRequests, clientIp } from '@/lib/rate-limit';
import { notify } from '@/lib/notify';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';
import {
  newReturnReference,
  parseReturnReason,
  cleanReturnDescription,
  orderEligibleForReturnReport,
  reportDto,
} from '@/lib/returns';
import { RETURN_REASON_LABELS } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Buyer-only return reports (RET-1, additive).
 *
 * POLICY: Green Gate does NOT do refunds. A report is a customer-service
 * workflow — it never moves money, never writes ledger entries and never
 * changes order/payment/payout state. Resolutions (replacement or store
 * credit) are decided by the administrator in the console.
 *
 * WHO CAN REPORT: ONLY the buyer of the order — verified server-side against
 * order.buyerId. Sellers, admins, guests and other buyers are all refused.
 */

const DESCRIPTION_MIN = 10;

/** The buyer's own return reports, newest first (capped for a fast response). */
export async function GET() {
  try {
    await bootstrap();
    const session = await requireUser();
    const rows = await db.returnReport.findMany({
      where: { buyerId: session.user.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { order: { select: { number: true } } },
    });
    const itemIds = rows.map((r) => r.orderItemId).filter((v): v is string => Boolean(v));
    const items = itemIds.length
      ? await db.orderItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true } })
      : [];
    const itemNames = new Map(items.map((i) => [i.id, i.name]));
    return Response.json({
      reports: rows.map((r) => reportDto(r, { orderNumber: r.order.number, itemName: r.orderItemId ? itemNames.get(r.orderItemId) ?? null : null })),
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('returns GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load your return reports.' }, { status: 500 });
  }
}

/** Open a new report on one of the caller's own orders. */
export async function POST(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireUser();

    const body = (await readJsonObject(req)) as { orderId?: string; orderItemId?: string; reason?: string; description?: string } | null;
    if (!body) return invalidJsonBody();

    const orderId = String(body.orderId ?? '').trim();
    if (!orderId) return Response.json({ error: 'Choose the order to report.' }, { status: 400 });
    const reason = parseReturnReason(body.reason);
    if (!reason) return Response.json({ error: 'Choose a reason for the report.' }, { status: 400 });
    const description = cleanReturnDescription(body.description);
    if (description.length < DESCRIPTION_MIN) {
      return Response.json({ error: `Tell us what happened (at least ${DESCRIPTION_MIN} characters).` }, { status: 400 });
    }

    // Burst guard (after validation, so a customer fixing a typo never burns
    // quota): 5 reports per account per day (shared across instances) —
    // genuine "not as seen" reports are rare; this caps abuse.
    const rl = await rateLimitShared(`returns:${session.user.id}:${clientIp(req)}`, 5, 24 * 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);

    // Ownership is the heart of "only the customer can report": the order must
    // belong to the signed-in buyer, full stop. Lookup matches the order-detail
    // route (human number or id) so the dashboard can hand either over.
    const order = await db.order.findUnique({
      where: orderId.startsWith('GG-') ? { number: orderId } : { id: orderId },
      select: {
        id: true, number: true, buyerId: true, status: true, paymentStatus: true, storeId: true,
        store: { select: { userId: true, name: true } },
        items: { select: { id: true } },
      },
    });
    if (!order) return Response.json({ error: 'Order not found.' }, { status: 404 });
    if (order.buyerId !== session.user.id) {
      return Response.json({ error: 'Only the customer who placed this order can report it.' }, { status: 403 });
    }
    const eligibility = orderEligibleForReturnReport(order);
    if (!eligibility.eligible) return Response.json({ error: eligibility.why }, { status: 409 });

    // One OPEN report per order — follow-ups continue on the same thread.
    const existing = await db.returnReport.findFirst({ where: { orderId: order.id, status: 'open' }, select: { reference: true } });
    if (existing) {
      return Response.json({ error: `There is already an open report on this order (${existing.reference}). We will get back to you on it.` }, { status: 409 });
    }

    const orderItemId = body.orderItemId ? String(body.orderItemId).trim() : '';
    if (orderItemId && !order.items.some((i) => i.id === orderItemId)) {
      return Response.json({ error: 'That item is not part of this order.' }, { status: 400 });
    }

    // Unique reference with one retry on the (astronomically unlikely) clash.
    let created;
    try {
      created = await db.returnReport.create({
        data: {
          reference: newReturnReference(),
          orderId: order.id,
          orderItemId: orderItemId || null,
          buyerId: session.user.id,
          storeId: order.storeId,
          reason,
          description,
          status: 'open',
        },
      });
    } catch {
      created = await db.returnReport.create({
        data: {
          reference: newReturnReference(),
          orderId: order.id,
          orderItemId: orderItemId || null,
          buyerId: session.user.id,
          storeId: order.storeId,
          reason,
          description,
          status: 'open',
        },
      });
    }

    // Timeline entry (buyer + seller + admin all see it on the order) — the
    // order's own status is deliberately untouched, as is every money table.
    await db.orderEvent.create({
      data: {
        orderId: order.id,
        status: 'return_report',
        note: `Return report ${created.reference} opened by the buyer — ${RETURN_REASON_LABELS[reason]}`,
      },
    }).catch(() => undefined);

    notify({
      userId: session.user.id,
      type: 'return_report',
      title: `Report ${created.reference} received`,
      body: `We have your report on order ${order.number}. Green Gate does not offer refunds — approved reports are resolved with a replacement or store credit. We will get back to you here.`,
      link: '/orders',
    });
    if (order.store.userId) {
      notify({
        userId: order.store.userId,
        type: 'return_report',
        title: `Buyer opened a return report (${created.reference})`,
        body: `Order ${order.number}: ${RETURN_REASON_LABELS[reason]}. The marketplace administrator reviews all reports — the order and its payout are unchanged.`,
        link: '/orders',
      });
    }

    return Response.json({ report: reportDto(created, { orderNumber: order.number }) }, { status: 201 });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('returns POST error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not open the report. Please try again.' }, { status: 500 });
  }
}
