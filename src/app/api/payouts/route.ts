import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, requireRole, authErrorResponse } from '@/lib/auth';
import { recordPair } from '@/lib/ledger';
import { bootstrap } from '@/lib/bootstrap';
import { audit } from '@/lib/audit';
import { rateLimitShared, clientIp, tooManyRequests } from '@/lib/rate-limit';
import { platformFeePercent } from '@/lib/ggpay';
import { payoutOnHold, PAYOUT_HOLD_ORDER_STATUSES } from '@/lib/payments';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';

export const dynamic = 'force-dynamic';

/**
 * Seller payouts — the "get paid like on Amazon" leg of GGPay.
 *
 * GET  — sellers see their own payouts + earnings summary; administrators see
 *        every payout on the marketplace. Money figures are computed from the
 *        real Payout rows, never estimated.
 * PATCH — administrators advance a payout's status (pending → processing →
 *         paid) once the EFT to the seller's bank account has gone out.
 *         Every change is audited; sellers are notified when paid.
 */
export async function GET() {
  try {
    await bootstrap();
    const session = await requireUser();

    // Role re-read from the database — the session token is not authoritative
    // (a demoted admin's week-long token must not keep the all-payouts view).
    const dbRole = (await db.user.findUnique({ where: { id: session.user.id }, select: { role: true } }))?.role;
    const isAdmin = dbRole === 'ADMIN';
    const where = isAdmin ? {} : { sellerId: session.user.id };

    const [payouts, agg] = await Promise.all([
      db.payout.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { order: { select: { number: true, buyerName: true, status: true } }, store: { select: { name: true, slug: true } } },
      }),
      db.payout.aggregate({
        where,
        _count: { _all: true },
        _sum: { grossCents: true, feeCents: true, netCents: true },
      }),
    ]);
    const byStatus = await db.payout.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
      _sum: { netCents: true },
    });
    // Unpaid payouts whose order was cancelled/refunded/returned — on hold.
    const held = await db.payout.aggregate({
      where: { ...where, status: { in: ['pending', 'processing'] }, order: { status: { in: PAYOUT_HOLD_ORDER_STATUSES } } },
      _count: { _all: true },
      _sum: { netCents: true },
    });

    const statusOf = (s: string) => byStatus.find((b) => b.status === s);
    return Response.json({
      payouts: payouts.map((p) => ({
        id: p.id,
        reference: p.reference,
        orderNumber: p.order?.number ?? '',
        storeName: isAdmin ? p.store?.name ?? '' : undefined,
        grossCents: p.grossCents,
        feeCents: p.feeCents,
        netCents: p.netCents,
        feePercent: p.feePercent,
        destination: p.destination,
        status: p.status,
        held: p.status !== 'paid' && (payoutOnHold(p.order?.status) || !p.releasedAt),
        releasedAt: p.releasedAt?.toISOString() ?? null,
        orderStatus: p.order?.status ?? null,
        paidAt: p.paidAt?.toISOString() ?? null,
        createdAt: p.createdAt.toISOString(),
      })),
      summary: {
        feePercent: platformFeePercent(),
        count: agg._count._all,
        grossCents: agg._sum.grossCents ?? 0,
        feeCents: agg._sum.feeCents ?? 0,
        netCents: agg._sum.netCents ?? 0,
        pending: { count: statusOf('pending')?._count._all ?? 0, netCents: statusOf('pending')?._sum.netCents ?? 0 },
        processing: { count: statusOf('processing')?._count._all ?? 0, netCents: statusOf('processing')?._sum.netCents ?? 0 },
        paid: { count: statusOf('paid')?._count._all ?? 0, netCents: statusOf('paid')?._sum.netCents ?? 0 },
        held: { count: held._count._all, netCents: held._sum.netCents ?? 0 },
      },
      scope: isAdmin ? 'all' : 'mine',
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('payouts GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load payouts.' }, { status: 500 });
  }
}

const PAYOUT_TRANSITIONS: Record<string, string[]> = {
  pending: ['processing', 'paid'],
  processing: ['paid'],
  paid: [],
};

export async function PATCH(req: NextRequest) {
  try {
    const session = await requireRole('ADMIN');
    const rl = await rateLimitShared(`payout-admin:${session.user.id}:${clientIp(req)}`, 60, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const body = (await readJsonObject(req)) as { payoutId?: string; status?: string } | null;
    if (!body) return invalidJsonBody();
    const payoutId = String(body.payoutId ?? '');
    const status = String(body.status ?? '');
    if (!['processing', 'paid'].includes(status)) {
      return Response.json({ error: 'Status must be processing or paid.' }, { status: 400 });
    }
    const payout = await db.payout.findUnique({ where: { id: payoutId }, include: { store: { select: { name: true } }, order: { select: { number: true, status: true } } } });
    if (!payout) return Response.json({ error: 'Payout not found.' }, { status: 404 });
    if (payoutOnHold(payout.order?.status)) {
      return Response.json({ error: `Order ${payout.order?.number ?? ''} was ${payout.order?.status} — this payout is on hold. The buyer's money must go back to the buyer — do not pay the seller.` }, { status: 409 });
    }
    // Escrow guard (additive): sellers are never paid for products that never
    // shipped. The payout must have been RELEASED from escrow first (The
    // Courier Guy confirmed collection, the 48h auto-release, or an admin
    // release from the Finance view).
    if (!payout.releasedAt) {
      return Response.json({ error: 'This payout is still in escrow — the courier must confirm collection first (or release it from the Finance view).' }, { status: 409 });
    }
    if (!(PAYOUT_TRANSITIONS[payout.status] ?? []).includes(status)) {
      return Response.json({ error: `A ${payout.status} payout cannot move to ${status}.` }, { status: 409 });
    }
    // Atomic transition: the status guard lives in the WHERE so two
    // concurrent admin updates can never both win.
    const moved = await db.payout.updateMany({ where: { id: payout.id, status: payout.status }, data: { status, paidAt: status === 'paid' ? new Date() : null } });
    if (moved.count === 0) {
      return Response.json({ error: `A ${payout.status} payout cannot move to ${status}.` }, { status: 409 });
    }
    // Escrow ledger (additive): the EFT that left the platform transfers the
    // seller's released earnings from escrow to "paid out" — the escrow
    // liability zeroes out and the Finance view shows the payout history.
    if (status === 'paid') {
      await db.$transaction(async (tx) => {
        await recordPair(tx, {
          amountCents: payout.netCents, state: 'settled', refType: 'payout', refId: payout.id,
          from: { kind: 'seller_escrow', refId: payout.storeId, label: 'Store escrow' },
          to: { kind: 'seller_paid', refId: payout.storeId, label: 'Paid to seller' },
          memo: `payout ${payout.reference} paid to ${payout.destination}`,
        });
      }).catch(() => undefined);
    }

    if (status === 'paid' && payout.sellerId) {
      const { notify } = await import('@/lib/notify');
      void notify({
        userId: payout.sellerId,
        type: 'payout_paid',
        title: 'Payout paid',
        body: `${payout.reference} — ${(payout.netCents / 100).toFixed(2)} ZAR was paid out to ${payout.destination}.`,
        link: '/dashboard',
      });
    }
    await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'payout_status_changed', target: payout.reference, detail: `${payout.status} → ${status}` });
    return Response.json({ ok: true });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('payouts PATCH error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not update the payout.' }, { status: 500 });
  }
}
