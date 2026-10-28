import { db } from '@/lib/db';
import { PAYOUT_HOLD_ORDER_STATUSES } from '@/lib/payments';
import { getShipmentStatus } from '@/lib/tcg';
import { recordPair, type Client } from '@/lib/ledger';

/**
 * Escrow for platform-collected orders (additive — nothing existing changes).
 *
 * When a buyer pays IN-APP (the marketplace is the merchant of record), the
 * seller's earnings are HELD until The Courier Guy confirms the parcel was
 * collected — then the payout releases. Owners' rule: sellers are never paid
 * for products that never shipped, and the buyer's shipping fee is tracked as
 * the courier budget that pays for the actual booking.
 *
 * Rails that pay the seller directly (their own PayFast / Ozow / Yoco) never
 * enter escrow — the money is already the seller's, and no marketplace payout
 * is queued for them (unchanged behaviour).
 */

/** Escrow states used on LedgerEntry.state for seller earnings. */
export const ESCROW_STATE = { held: 'held', released: 'released', refunded: 'refunded' } as const;

export interface SettlementSplitInput {
  orderId: string;
  storeId: string;
  buyerId: string | null;
  netCents: number;    // seller earnings (subtotal − fee)
  feeCents: number;    // marketplace commission
  shippingCents: number; // the buyer's courier fee (becomes the courier budget)
  discountCents: number; // marketplace discount absorbed, if any
  totalCents: number;  // what the buyer actually paid
  reference: string;   // payment reference (audit trail)
}

/**
 * Split a settled in-app payment into escrow accounts. MUST run inside the
 * settlement transaction (same atomic claim as the Payout row), so a racing
 * webhook can never double-write: the split only ever runs once, when the
 * order is claimed.
 */
export async function splitSettlementEscrow(tx: Client, input: SettlementSplitInput): Promise<void> {
  const memo = `order ${input.orderId} · payment ${input.reference}`;
  // Money in.
  await recordPair(tx, {
    amountCents: input.totalCents, state: 'settled', refType: 'order', refId: input.orderId,
    from: { kind: 'buyer', refId: input.buyerId, label: 'Buyer' },
    to: { kind: 'platform_cash' },
    memo: input.discountCents > 0 ? `${memo} · marketplace discount absorbed: R${(input.discountCents / 100).toFixed(2)}` : memo,
  }, { from: 'settled', to: 'settled' });
  // Seller's earnings — HELD in escrow until shipment proof.
  await recordPair(tx, {
    amountCents: input.netCents, state: ESCROW_STATE.held, refType: 'order', refId: input.orderId,
    from: { kind: 'platform_cash' },
    to: { kind: 'seller_escrow', refId: input.storeId, label: 'Store escrow' },
    memo,
  }, { from: 'settled', to: ESCROW_STATE.held });
  // The buyer's shipping fee becomes the courier budget.
  if (input.shippingCents > 0) {
    await recordPair(tx, {
      amountCents: input.shippingCents, state: 'settled', refType: 'order', refId: input.orderId,
      from: { kind: 'platform_cash' },
      to: { kind: 'platform_shipping' },
      memo: `${memo} · courier budget`,
    }, { from: 'settled', to: 'settled' });
  }
  // Marketplace commission.
  if (input.feeCents > 0) {
    await recordPair(tx, {
      amountCents: input.feeCents, state: 'settled', refType: 'order', refId: input.orderId,
      from: { kind: 'platform_cash' },
      to: { kind: 'platform_fees' },
      memo,
    }, { from: 'settled', to: 'settled' });
  }
}

/**
 * Record the courier spend when a TCG booking succeeds (the buyer's shipping
 * budget paying for the real booking). Best-effort: called AFTER the booking
 * transaction committed, never blocks or fails the booking itself. If the
 * budget is empty the balance simply goes negative — the admin Finance view
 * shows it and prompts a TCG wallet top-up. Shipping must never fail.
 */
export async function recordCourierSpend(orderId: string, trackingRef: string, shippingCents: number): Promise<void> {
  try {
    if (!Number.isFinite(shippingCents) || shippingCents <= 0) return;
    await db.$transaction(async (tx) => {
      await recordPair(tx, {
        amountCents: shippingCents, state: 'settled', refType: 'courier_booking', refId: trackingRef,
        from: { kind: 'platform_shipping' },
        to: { kind: 'courier_tcg' },
        memo: `courier booking for order ${orderId} · tracking ${trackingRef}`,
      });
    });
  } catch (e) {
    console.error('courier spend ledger error:', e instanceof Error ? e.message : e);
  }
}

/** The seller-escrow entries created by a settlement (one per order). */
async function escrowOrderEntries(g: Client, orderId: string) {
  return g.ledgerEntry.findMany({
    where: { refType: 'order', refId: orderId, account: { kind: 'seller_escrow' } },
    select: { id: true, state: true, amountCents: true, accountId: true },
  });
}

export type ReleaseVia = 'courier_scan' | 'auto_48h' | 'admin';

/**
 * Release an order's escrow: seller-escrow entries flip held → released and
 * the Payout becomes eligible (releasedAt set). Idempotent — re-running is a
 * no-op. Refunded/cancelled orders are never released.
 */
export async function releaseEscrowForOrder(
  orderId: string,
  via: ReleaseVia,
  detail?: string,
): Promise<{ ok: boolean; reason?: string; netCents?: number }> {
  try {
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: { id: true, number: true, status: true, paymentStatus: true, storeId: true, store: { select: { userId: true, name: true } } },
    });
    if (!order) return { ok: false, reason: 'order not found' };
    if (PAYOUT_HOLD_ORDER_STATUSES.includes(order.status)) return { ok: false, reason: `order is ${order.status}` };
    if (order.paymentStatus !== 'paid') return { ok: false, reason: 'order is not paid' };

    const memo = detail ?? (via === 'courier_scan' ? 'The Courier Guy confirmed collection' : via === 'auto_48h' ? 'Auto-released 48h after booking (no contrary scan)' : 'Released by marketplace admin');
    let netCents = 0;
    await db.$transaction(async (tx) => {
      const entries = await escrowOrderEntries(tx, orderId);
      const held = entries.filter((e) => e.state === ESCROW_STATE.held);
      netCents = entries.filter((e) => e.state !== ESCROW_STATE.refunded).reduce((s, e) => s + e.amountCents, 0);
      if (held.length > 0) {
        await tx.ledgerEntry.updateMany({
          where: { id: { in: held.map((e) => e.id) } },
          data: { state: ESCROW_STATE.released, memo: `${memo} (order ${order.number})` },
        });
      }
      await tx.payout.updateMany({
        where: { orderId, releasedAt: null },
        data: { releasedAt: new Date(), holdReason: null },
      });
      await tx.orderEvent.create({
        data: { orderId, status: order.status, note: `Seller payout released from escrow (${via}): ${memo}.` },
      }).catch(() => undefined);
    });
    if (order.store.userId) {
      void (async () => {
        const { notify } = await import('@/lib/notify');
        void notify({
          userId: order.store.userId,
          type: 'payout_queued',
          title: 'Earnings released — ready for payout',
          body: `Order ${order.number}: the courier confirmed your parcel is on its way, so your earnings are released from escrow and queued for payout.`,
          link: '/dashboard',
        });
      })().catch(() => undefined);
    }
    return { ok: true, netCents };
  } catch (e) {
    console.error('escrow release error:', e instanceof Error ? e.message : e);
    return { ok: false, reason: e instanceof Error ? e.message : 'release error' };
  }
}

/**
 * Refund-path escrow teardown: an order was cancelled/refunded BEFORE its
 * escrow released. The held earnings go back to the buyer (together with the
 * commission and any shipping fee that was not already spent on a courier
 * booking). Best-effort — never blocks the cancellation itself.
 */
export async function refundEscrowForOrder(orderId: string, reason: string): Promise<void> {
  try {
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, number: true, status: true, buyerId: true, storeId: true,
        subtotalCents: true, totalCents: true, discountCents: true, shippingCents: true,
        courierTrackingRef: true,
      },
    });
    if (!order) return;
    // Shipping already spent on a real courier booking is not refundable here.
    const orderSpend = await db.ledgerEntry.aggregate({
      where: { refType: 'courier_booking', memo: { contains: `order ${orderId}` }, account: { kind: 'courier_tcg' } },
      _sum: { amountCents: true },
    });
    const bookedSpend = orderSpend._sum.amountCents ?? 0;
    await db.$transaction(async (tx) => {
      // Read + flip INSIDE the transaction with a state guard: a concurrent
      // release (courier scan, 48h auto, admin) can never interleave, and two
      // concurrent refunds can never both book the refund pairs. Only entries
      // still held at commit time are refunded; if a release won the race this
      // becomes a no-op and the payout flows to the seller instead.
      const entries = await escrowOrderEntries(tx, orderId);
      const stillHeld = entries.filter((e) => e.state === ESCROW_STATE.held);
      if (stillHeld.length === 0) return; // already released or refunded — nothing to tear down
      const flipped = await tx.ledgerEntry.updateMany({
        where: { id: { in: stillHeld.map((e) => e.id) }, state: ESCROW_STATE.held },
        data: { state: ESCROW_STATE.refunded, memo: `order ${order.number} refunded: ${reason.slice(0, 140)}` },
      });
      if (flipped.count === 0) return; // raced with a release — the release won
      // Seller earnings + commission + unspent shipping go back to the buyer.
      const net = stillHeld.reduce((s, e) => s + e.amountCents, 0);
      const fee = Math.max(0, order.subtotalCents - net); // the commission part of the subtotal
      const refundableShipping = Math.max(0, order.shippingCents - bookedSpend);
      const refundTotal = net + fee + refundableShipping;
      if (fee > 0) {
        await recordPair(tx, {
          amountCents: fee, state: 'refunded', refType: 'refund', refId: orderId,
          from: { kind: 'platform_fees' }, to: { kind: 'buyer', refId: order.buyerId, label: 'Buyer refund' },
          memo: `commission returned to buyer for order ${order.number}`,
        });
      }
      if (refundableShipping > 0) {
        await recordPair(tx, {
          amountCents: refundableShipping, state: 'refunded', refType: 'refund', refId: orderId,
          from: { kind: 'platform_shipping' }, to: { kind: 'buyer', refId: order.buyerId, label: 'Buyer refund' },
          memo: `unspent courier budget returned for order ${order.number}`,
        });
      }
      if (refundTotal > 0) {
        await recordPair(tx, {
          amountCents: refundTotal, state: 'refunded', refType: 'refund', refId: orderId,
          from: { kind: 'platform_cash' }, to: { kind: 'buyer', refId: order.buyerId, label: 'Buyer refund' },
          memo: `refund owed to buyer for order ${order.number}: ${reason.slice(0, 120)}`,
        }, { from: 'refunded', to: 'refunded' });
      }
      await tx.payout.updateMany({
        where: { orderId, releasedAt: null },
        data: { holdReason: `order refunded — ${reason.slice(0, 100)}` },
      });
      await tx.orderEvent.create({
        data: { orderId, status: order.status, note: `Escrow refunded to buyer (R${(refundTotal / 100).toFixed(2)}): ${reason.slice(0, 140)}` },
      }).catch(() => undefined);
    });
  } catch (e) {
    console.error('escrow refund error:', e instanceof Error ? e.message : e);
  }
}

/** TCG status words that prove the parcel is on its way (collection or later). */
const SHIPMENT_PROOF_RE = /collect|transit|dispatch|deliver|picked|scan|depot|hub/i;
/** Auto-release fallback: release 48h after a booking with no contrary scan. */
const AUTO_RELEASE_AFTER_MS = 48 * 3600_000;

/** Pickup-point orders (PAXI / Pudo) are never booked with a courier — kept in
 *  sync with isPickupOrder in courier-booking.ts (inlined here to avoid a
 *  circular import: courier-booking already imports this module). */
const PICKUP_METHOD_RE = /paxi|pudo/i;
const PICKUP_ADDRESS_RE = /^(PAXI|Pudo locker|Pudo locker point):/i;

export interface ReleaseSweepResult {
  checked: number;
  released: number;
  viaScan: number;
  viaAuto: number;
  errors: string[];
}

/**
 * Release sweep — rides the daily cron next to the booking sweep: every paid,
 * booked, still-held order gets its TCG shipment status checked; a collection
 * (or later) scan releases the escrow, and 48h after a booking with no
 * contrary scan it auto-releases (a missed scan must never strand a good
 * seller's money). Refunded/cancelled orders are skipped. Never throws.
 */
export async function sweepEscrowReleases(limit = 25): Promise<ReleaseSweepResult> {
  const result: ReleaseSweepResult = { checked: 0, released: 0, viaScan: 0, viaAuto: 0, errors: [] };
  try {
    // Never-releaseable payouts (order cancelled / refunded / returned) are
    // excluded HERE rather than skipped in the loop below: they would other-
    // wise sit in the oldest-first window forever, starving real releases
    // once the queue fills (observed locally: a held payout 49h past its
    // auto-release clock never fired because ten terminal payouts occupied
    // the take-10 window ahead of it).
    const payouts = await db.payout.findMany({
      where: { releasedAt: null, status: { not: 'paid' }, order: { status: { notIn: PAYOUT_HOLD_ORDER_STATUSES } } },
      select: {
        orderId: true,
        order: {
          select: {
            id: true, status: true, courierTrackingRef: true, courierBookedAt: true,
            courierStatus: true, createdAt: true, shippingMethod: true, address: true,
          },
        },
      },
      take: Math.min(100, Math.max(1, limit)),
      orderBy: { createdAt: 'asc' },
    });
    for (const p of payouts) {
      const order = p.order;
      if (!order) continue;
      if (PAYOUT_HOLD_ORDER_STATUSES.includes(order.status)) continue;
      let release: ReleaseVia | null = null;
      let detail: string | undefined;
      const booked = Boolean(order.courierTrackingRef && order.courierBookedAt);
      if (booked) {
        result.checked++;
        const age = Date.now() - order.courierBookedAt!.getTime();
        if (age >= AUTO_RELEASE_AFTER_MS) {
          release = 'auto_48h';
          detail = 'Auto-released 48h after the courier booking (no contrary scan from The Courier Guy).';
        } else {
          const status = await getShipmentStatus(order.courierTrackingRef!);
          if (status.ok && SHIPMENT_PROOF_RE.test(status.status)) {
            release = 'courier_scan';
            detail = `The Courier Guy status "${status.status}" confirms the parcel is on its way.`;
          }
        }
      } else {
        // No courier booking exists. Pickup-point orders never get one, and a
        // booking that permanently failed (gateway outage, empty courier
        // wallet) must never hold a good seller's money hostage either — both
        // get the same 48h auto-release clock, measured from the order itself.
        const isPickup = PICKUP_METHOD_RE.test(order.shippingMethod ?? '') || PICKUP_ADDRESS_RE.test(order.address ?? '');
        const bookingFailed = String(order.courierStatus ?? '').startsWith('booking_failed');
        if (!isPickup && !bookingFailed) continue;
        const age = Date.now() - order.createdAt.getTime();
        if (age < AUTO_RELEASE_AFTER_MS) continue;
        result.checked++;
        release = 'auto_48h';
        detail = isPickup
          ? 'Auto-released 48h after payment — pickup-point orders are handed over at the locker, no courier booking is needed.'
          : 'Auto-released 48h after the courier booking failed — booking retries continue, but the seller is not penalised for a gateway outage.';
      }
      if (release) {
        const res = await releaseEscrowForOrder(order.id, release, detail);
        if (res.ok) {
          result.released++;
          if (release === 'courier_scan') result.viaScan++;
          else result.viaAuto++;
        } else if (res.reason) {
          result.errors.push(`${order.id}: ${res.reason}`);
        }
      }
    }
    return result;
  } catch (e) {
    console.error('escrow release sweep error:', e instanceof Error ? e.message : e);
    result.errors.push(e instanceof Error ? e.message : 'sweep error');
    return result;
  }
}
