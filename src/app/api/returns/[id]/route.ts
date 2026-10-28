import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { rateLimitShared, tooManyRequests } from '@/lib/rate-limit';
import { notify } from '@/lib/notify';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';
import { BUYER_REPORT_ACTIONS, cleanNote, reportDto } from '@/lib/returns';
import { RETURN_REASON_LABELS, RETURN_STATUS_LABELS, type ReturnReportStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * One return report: the owner buyer can view it, withdraw it (while under
 * review) and mark it "sent back" (once approved). Administrators act through
 * POST /api/admin (return_report_update) — never through this buyer route.
 *
 * POLICY: no refunds anywhere. These buyer actions only move the report
 * through its service workflow; order status, ledger, escrow and payouts are
 * never touched.
 */

/** Load the report plus just enough order data for the ownership check. */
async function loadOwned(id: string, userId: string) {
  const row = await db.returnReport.findUnique({
    where: { id },
    include: { order: { select: { number: true, buyerId: true } } },
  });
  if (!row) return { error: 'Report not found.', status: 404 as const };
  // Only the buyer who opened the report (or an administrator) may act on it.
  const isAdmin = row.buyerId !== userId
    && (await db.user.findUnique({ where: { id: userId }, select: { role: true } }))?.role === 'ADMIN';
  if (row.buyerId !== userId && !isAdmin) {
    return { error: 'You can only view your own return reports.', status: 403 as const };
  }
  return { row, isOwner: row.buyerId === userId };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await bootstrap();
    const session = await requireUser();
    const { id } = await ctx.params;
    const found = await loadOwned(id, session.user.id);
    if ('error' in found) return Response.json({ error: found.error }, { status: found.status });
    return Response.json({
      report: reportDto(found.row, { orderNumber: found.row.order.number }),
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('return GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load the report.' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await bootstrap();
    const session = await requireUser();
    const { id } = await ctx.params;

    const rl = await rateLimitShared(`returns-act:${session.user.id}`, 20, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const body = (await readJsonObject(req)) as { action?: string; note?: string } | null;
    if (!body) return invalidJsonBody();
    const action = String(body.action ?? '').trim();
    const spec = BUYER_REPORT_ACTIONS[action];
    if (!spec) {
      return Response.json({ error: 'Unknown action.' }, { status: 400 });
    }

    const found = await loadOwned(id, session.user.id);
    if ('error' in found) return Response.json({ error: found.error }, { status: found.status });
    // Withdraw / mark-sent-back are the BUYER's own moves — an administrator
    // viewing the report cannot perform them here.
    if (!found.isOwner) {
      return Response.json({ error: 'Only the customer who opened this report can do that.' }, { status: 403 });
    }

    const row = found.row;
    if (!spec.from.includes(row.status as ReturnReportStatus)) {
      return Response.json(
        { error: `This report is ${RETURN_STATUS_LABELS[row.status as keyof typeof RETURN_STATUS_LABELS] ?? row.status} — that action no longer applies.` },
        { status: 409 },
      );
    }

    const note = cleanNote(body.note, 500);
    const updated = await db.returnReport.update({
      where: { id: row.id },
      data: { status: spec.to },
    });

    const actionNote = action === 'withdraw'
      ? `Return report ${row.reference} withdrawn by the buyer${note ? ` — "${note}"` : ''}`
      : `Return report ${row.reference}: buyer marked the parcel as sent back${note ? ` — "${note}"` : ''}`;
    await db.orderEvent.create({
      data: { orderId: row.orderId, status: 'return_report', note: actionNote },
    }).catch(() => undefined);

    if (action === 'mark_sent_back') {
      notify({
        userId: row.buyerId,
        type: 'return_report_update',
        title: `Return on its way (${row.reference})`,
        body: `Thanks — we have noted that the parcel for order ${row.order.number} is on its way back. The administrator takes it from here.`,
        link: '/orders',
      });
    }

    return Response.json({ report: reportDto(updated, { orderNumber: row.order.number }) });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('return PATCH error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not update the report. Please try again.' }, { status: 500 });
  }
}
