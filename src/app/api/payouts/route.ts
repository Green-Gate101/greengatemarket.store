import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, requireRole, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { audit } from '@/lib/audit';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';
import { platformFeePercent } from '@/lib/ggpay';

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

    const isAdmin = session.user.role === 'ADMIN';
    const where = isAdmin ? {} : { sellerId: session.user.id };

    const [payouts, agg] = await Promise.all([
      db.payout.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { order: { select: { number: true, buyerName: true } }, store: { select: { name: true, slug: true } } },
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
    const rl = rateLimit(`payout-admin:${session.user.id}:${clientIp(req)}`, 60, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const body = (await req.json()) as { payoutId?: string; status?: string };
    const payoutId = String(body.payoutId ?? '');
    const status = String(body.status ?? '');
    if (!['processing', 'paid'].includes(status)) {
      return Response.json({ error: 'Status must be processing or paid.' }, { status: 400 });
    }
    const payout = await db.payout.findUnique({ where: { id: payoutId }, include: { store: { select: { name: true } } } });
    if (!payout) return Response.json({ error: 'Payout not found.' }, { status: 404 });
    if (!(PAYOUT_TRANSITIONS[payout.status] ?? []).includes(status)) {
      return Response.json({ error: `A ${payout.status} payout cannot move to ${status}.` }, { status: 409 });
    }
    // Atomic transition: the status guard lives in the WHERE so two
    // concurrent admin updates can never both win.
    const moved = await db.payout.updateMany({ where: { id: payout.id, status: payout.status }, data: { status, paidAt: status === 'paid' ? new Date() : null } });
    if (moved.count === 0) {
      return Response.json({ error: `A ${payout.status} payout cannot move to ${status}.` }, { status: 409 });
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
