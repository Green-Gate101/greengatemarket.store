/**
 * The Courier Guy booking pipeline — the bridge between a PAID order and a
 * real courier collection.
 *
 * Flow (all best-effort, never blocking money or checkout):
 *  1. Payment settles (any rail: PayFast, Ozow, Yoco, GGPay) → the settlement
 *     hook schedules bookShipmentForOrder(orderId).
 *  2. On any failure the order keeps `courierTrackingRef = null` and records
 *     `courierStatus = "booking_failed: <reason>"` (e.g. insufficient TCG
 *     wallet funds). Retry layers: the seller's dashboard load, the seller
 *     marking the parcel packed/shipped, a manual "Book courier" button, and
 *     the daily cron sweep.
 *  3. Success stores the TCG tracking reference + shipment id, writes an
 *     OrderEvent, and notifies the seller (waybill ready) and the buyer
 *     (tracked parcel booked).
 *
 * Pickup-point orders (PAXI / Pudo) are NEVER booked with TCG.
 */

import { db } from '@/lib/db';
import { tcgConfigured, bookShipment, storeCollectionAddress, orderDeliveryAddress, tcgParcelObjects, type ParcelSpec } from '@/lib/tcg';

/** Statuses that mean "the money is in — a courier should be on its way". */
const BOOKABLE_STATUSES = ['confirmed', 'processing', 'packed', 'ready_for_collection', 'shipped', 'in_transit'];

/** How often a failed booking may be retried by the passive sweeps. */
const RETRY_AFTER_MS = 15 * 60_000;

/** Pickup-point orders ship through the locker networks, not The Courier Guy. */
function isPickupOrder(order: { shippingMethod: string; address: string }): boolean {
  return /paxi|pudo/i.test(order.shippingMethod) || /^(PAXI|Pudo locker|Pudo locker point):/i.test(order.address);
}

async function buildParcels(orderId: string): Promise<{ parcels: ParcelSpec[]; descriptions: string[] } | null> {
  const items = await db.orderItem.findMany({
    where: { orderId },
    select: {
      name: true,
      quantity: true,
      productId: true,
      product: { select: { weightGrams: true, lengthCm: true, widthCm: true, heightCm: true } },
    },
  });
  if (items.length === 0) return null;
  const parcels: ParcelSpec[] = [];
  const descriptions: string[] = [];
  for (const item of items) {
    const units = Math.min(20, Math.max(1, item.quantity));
    for (let i = 0; i < units; i++) {
      parcels.push({
        weightKg: Math.max(0.1, item.product.weightGrams / 1000),
        lengthCm: item.product.lengthCm,
        widthCm: item.product.widthCm,
        heightCm: item.product.heightCm,
      });
      descriptions.push(item.name);
    }
    if (parcels.length >= 20) break;
  }
  return { parcels: parcels.slice(0, 20), descriptions: descriptions.slice(0, 20) };
}

/**
 * Book the courier for one paid order. Returns a result object and NEVER
 * throws — every failure lands in the order's courierStatus.
 */
export async function bookShipmentForOrder(
  orderId: string,
  opts: { force?: boolean } = {},
): Promise<{ ok: true; trackingReference: string } | { ok: false; reason: string; skipped?: boolean }> {
  try {
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, number: true, status: true, paymentStatus: true,
        buyerName: true, buyerEmail: true, buyerPhone: true, address: true,
        subtotalCents: true, totalCents: true, shippingMethod: true,
        shippingOptionCode: true, courierTrackingRef: true, courierStatus: true,
        courierBookedAt: true, deliveryLat: true, deliveryLng: true,
        store: {
          select: {
            id: true, name: true, location: true, phone: true,
            streetAddress: true, city: true, province: true, postalCode: true,
            dispatchDays: true, userId: true,
            user: { select: { email: true, name: true } },
          },
        },
      },
    });
    if (!order) return { ok: false, reason: 'order not found', skipped: true };
    if (order.courierTrackingRef) return { ok: true, trackingReference: order.courierTrackingRef };
    if (!BOOKABLE_STATUSES.includes(order.status) || order.paymentStatus !== 'paid') {
      return { ok: false, reason: 'order is not paid yet', skipped: true };
    }
    if (isPickupOrder(order)) return { ok: false, reason: 'pickup-point order — no courier booking needed', skipped: true };
    if (!opts.force) {
      // Passive sweeps back off after a fresh failure so the quota is not burned.
      if (order.courierStatus?.startsWith('booking_failed') && order.courierBookedAt && Date.now() - order.courierBookedAt.getTime() < RETRY_AFTER_MS) {
        return { ok: false, reason: 'recent attempt failed — backing off', skipped: true };
      }
    }
    if (!tcgConfigured()) {
      await db.order.update({ where: { id: order.id }, data: { courierStatus: 'booking_failed: The Courier Guy API key is not configured' } }).catch(() => undefined);
      return { ok: false, reason: 'The Courier Guy API key is not configured' };
    }

    const collection = storeCollectionAddress(order.store);
    const delivery = orderDeliveryAddress(order.address, order.deliveryLat, order.deliveryLng);
    if (!collection) return finishFailure(order.id, order.number, 'the store address could not be mapped for collection');
    if (!delivery) return finishFailure(order.id, order.number, 'the delivery address could not be mapped');
    const built = await buildParcels(order.id);
    if (!built) return finishFailure(order.id, order.number, 'the order has no items to ship');

    const result = await bookShipment({
      collection,
      delivery,
      collectionContact: {
        name: order.store.user?.name || order.store.name,
        mobile: order.store.phone || '0000000000',
        email: order.store.user?.email || 'support@greengatemarket.store',
      },
      deliveryContact: {
        name: order.buyerName,
        mobile: order.buyerPhone,
        email: order.buyerEmail,
      },
      parcels: tcgParcelObjects(built.parcels, (i) => built.descriptions[i]),
      serviceCode: order.shippingOptionCode,
      declaredValueCents: order.subtotalCents,
      customerReference: order.number,
      collectionInDays: order.store.dispatchDays && order.store.dispatchDays > 0 ? order.store.dispatchDays : 1,
    });

    if (!result.ok) return finishFailure(order.id, order.number, result.reason);

    await db.$transaction([
      db.order.update({
        where: { id: order.id },
        data: {
          courierTrackingRef: result.trackingReference || null,
          courierShipmentId: result.shipmentId,
          courierStatus: 'booked',
          courierBookedAt: new Date(),
        },
      }),
      db.orderEvent.create({
        data: {
          orderId: order.id,
          status: order.status,
          note: `The Courier Guy collection booked — tracking reference ${result.trackingReference || '(pending)'}${result.shipmentId ? ` (shipment ${result.shipmentId})` : ''}, service ${result.serviceCode}`,
        },
      }),
    ]);
    // Waybill is ready for the seller; the buyer gets a tracked parcel.
    if (order.store.userId) {
      void (async () => {
        const { notify } = await import('@/lib/notify');
        void notify({
          userId: order.store.userId,
          type: 'order_status',
          title: 'Courier booked — waybill ready',
          body: `Order ${order.number}: The Courier Guy collection is booked (tracking ${result.trackingReference || 'pending'}). Print the waybill from your dashboard.`,
          link: '/dashboard',
        });
      })().catch(() => undefined);
    }
    if (order.buyerEmail) {
      void (async () => {
        const { sendOrderStatusEmail } = await import('@/lib/email');
        void sendOrderStatusEmail({
          to: order.buyerEmail,
          orderNumber: order.number,
          statusLabel: 'Courier booked — your parcel is tracked',
          note: result.trackingReference ? `The Courier Guy tracking reference: ${result.trackingReference}.` : undefined,
        });
      })().catch(() => undefined);
    }
    return { ok: true, trackingReference: result.trackingReference };
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'booking error';
    console.error('courier booking error:', reason);
    return { ok: false, reason };
  }
}

async function finishFailure(orderId: string, orderNumber: string, reason: string): Promise<{ ok: false; reason: string }> {
  const short = reason.slice(0, 180);
  await db.order
    .update({ where: { id: orderId }, data: { courierStatus: `booking_failed: ${short}`, courierBookedAt: new Date() } })
    .catch(() => undefined);
  await db.orderEvent
    .create({ data: { orderId, status: 'processing', note: `Courier booking failed: ${short} — the seller can still ship manually; booking retries automatically.` } })
    .catch(() => undefined);
  console.error(`courier booking failed for ${orderNumber}: ${short}`);
  return { ok: false, reason: short };
}

/**
 * Retry pass: books every paid, unbooked, bookable order (optionally scoped
 * to one store). Failures already carry their own back-off. Never throws.
 */
export async function sweepPendingBookings(opts: { storeId?: string; limit?: number } = {}): Promise<{ attempted: number; booked: number }> {
  try {
    if (!tcgConfigured()) return { attempted: 0, booked: 0 };
    const staleBefore = new Date(Date.now() - RETRY_AFTER_MS);
    const orders = await db.order.findMany({
      where: {
        paymentStatus: 'paid',
        status: { in: BOOKABLE_STATUSES },
        courierTrackingRef: null,
        ...(opts.storeId ? { storeId: opts.storeId } : {}),
        OR: [{ courierBookedAt: null }, { courierBookedAt: { lt: staleBefore } }],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: Math.min(10, opts.limit ?? 5),
    });
    let booked = 0;
    for (const o of orders) {
      const res = await bookShipmentForOrder(o.id, { force: false });
      if (res.ok) booked++;
    }
    return { attempted: orders.length, booked };
  } catch (e) {
    console.error('courier booking sweep error:', e instanceof Error ? e.message : e);
    return { attempted: 0, booked: 0 };
  }
}
