import { db } from '@/lib/db';
import { requireStoreSeller, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { formatMoney } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * The seller's escrow earnings view (additive — nothing existing changes):
 * how much is HELD until the courier confirms collection, how much has been
 * RELEASED for payout, and how much has actually been PAID out. Sources the
 * numbers from the payout rows so the seller sees exactly what the
 * marketplace's Finance view sees.
 */
export async function GET() {
  try {
    await bootstrap();
    const session = await requireStoreSeller();
    const store = await db.store.findUnique({ where: { userId: session.user.id }, select: { id: true, name: true } });
    if (!store) return Response.json({ heldCents: 0, releasedCents: 0, paidCents: 0, payouts: [] });

    const payouts = await db.payout.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        order: {
          select: {
            number: true, status: true, courierStatus: true, courierBookedAt: true, courierTrackingRef: true,
          },
        },
      },
    });

    const HOLD_STATUSES = ['cancelled', 'refunded', 'returned'];
    const heldCents = payouts
      .filter((p) => p.status !== 'paid' && p.releasedAt === null && !HOLD_STATUSES.includes(p.order?.status ?? ''))
      .reduce((s, p) => s + p.netCents, 0);
    const releasedCents = payouts
      .filter((p) => p.status !== 'paid' && p.releasedAt !== null)
      .reduce((s, p) => s + p.netCents, 0);
    const paidCents = payouts.filter((p) => p.status === 'paid').reduce((s, p) => s + p.netCents, 0);

    const view = (p: (typeof payouts)[number]) => ({
      id: p.id,
      reference: p.reference,
      orderNumber: p.order?.number ?? '',
      netCents: p.netCents,
      netLabel: formatMoney(p.netCents),
      status: p.status,
      // Escrow state for this payout: held until release (courier scan, 48h
      // auto-release or an admin release), then queued for payout.
      escrow: p.releasedAt ? 'released' : (HOLD_STATUSES.includes(p.order?.status ?? '') ? 'refunded' : 'held'),
      courierStatus: p.order?.courierStatus ?? null,
      courierBookedAt: p.order?.courierBookedAt?.toISOString() ?? null,
      courierTrackingRef: p.order?.courierTrackingRef ?? null,
      releasedAt: p.releasedAt?.toISOString() ?? null,
      paidAt: p.paidAt?.toISOString() ?? null,
      destination: p.destination,
      createdAt: p.createdAt.toISOString(),
    });

    return Response.json({
      storeName: store.name,
      heldCents,
      heldLabel: formatMoney(heldCents),
      releasedCents,
      releasedLabel: formatMoney(releasedCents),
      paidCents,
      paidLabel: formatMoney(paidCents),
      payouts: payouts.map(view),
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('seller earnings GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load your earnings.' }, { status: 500 });
  }
}
