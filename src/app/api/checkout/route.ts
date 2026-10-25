import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { getShippingRates, FALLBACK_RATES } from '@/lib/shipping';
import { getPaymentProvider } from '@/lib/payments';
import { payfastEnabled } from '@/lib/payfast';
import { ggpayAcceptsCards } from '@/lib/ggpay';
import { orderNumber } from '@/lib/password';
import { audit } from '@/lib/audit';
import { rateLimitShared, clientIp, tooManyRequests } from '@/lib/rate-limit';
import { bootstrap } from '@/lib/bootstrap';
import { formatMoney } from '@/lib/types';
import { recordInteraction } from '@/lib/recommender';
import { notify } from '@/lib/notify';
import { decryptSecret } from '@/lib/secret-box';
import { yocoCreateCheckout, yocoKeyUsable } from '@/lib/yoco';
import { escapeHtml } from '@/lib/email';
import { publicPaymentStore, STORE_PAYMENT_SELECT } from '@/lib/order-payment-options';
import { eftDetailsFor, type EftDetails } from '@/lib/payments';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Checkout (spec #17/#19):
 *  - authenticated user, server-side cart
 *  - ALL pricing recomputed server-side from the database
 *  - concurrency-safe stock decrement (guarded updateMany)
 *  - idempotency key prevents duplicate orders on retry
 *  - multi-seller carts are split into one order per store
 *  - bank-transfer payment intent (no browser-declared "paid", ever)
 *  - emails are best-effort and never block the order
 */

interface CheckoutBody {
  buyerName?: string;
  buyerEmail?: string;
  buyerPhone?: string;
  address?: string;
  shippingCode?: string;
  idempotencyKey?: string;
  latitude?: number;  // exact GPS fix captured at checkout — goes to the order
  longitude?: number; // and to The Courier Guy's rate gateway
  accuracyMeters?: number;
  pinSource?: string; // gps | search | saved — where the client's pin came from
}

/** Whitespace/case-insensitive comparison so "12 Long Street" ≡ "12  long street". */
function normalizedAddress(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Resolves the delivery pin that rides with EVERY order:
 *  1. coordinates captured at checkout (GPS fix or a saved location's pin) win;
 *  2. otherwise, when the typed address IS the buyer's saved default location
 *     ("always deliver here"), that location's pin is attached automatically —
 *     the buyer never has to re-capture, the courier always gets the pin.
 */
async function resolveDeliveryPin(
  userId: string,
  address: string,
  body: CheckoutBody,
): Promise<{ lat: number | null; lng: number | null; accuracy: number | null; source: string | null }> {
  const lat = Number.isFinite(body.latitude) ? Number(body.latitude) : null;
  const lng = Number.isFinite(body.longitude) ? Number(body.longitude) : null;
  const accuracy = Number.isFinite(body.accuracyMeters) ? Math.round(Number(body.accuracyMeters)) : null;
  if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return {
      lat,
      lng,
      accuracy,
      // 'gps' keeps the pre-existing label for all body coords; a suggestion
      // pick or saved-location pick declares itself via pinSource.
      source: ['gps', 'search', 'saved'].includes(String(body.pinSource)) ? String(body.pinSource) : 'gps',
    };
  }
  // Automatic fallback: does the typed address match the saved default location?
  const type = normalizedAddress(address);
  if (type.length >= 10) {
    const def = await db.address.findFirst({
      where: { userId, isDefault: true, latitude: { not: null }, longitude: { not: null } },
      orderBy: { updatedAt: 'desc' },
    });
    if (def?.latitude != null && def?.longitude != null) {
      const defLine = normalizedAddress([def.street, def.city, def.province, def.postalCode].filter(Boolean).join(', '));
      if (defLine.length >= 10 && (type === defLine || type.includes(defLine) || defLine.includes(type))) {
        return {
          lat: def.latitude,
          lng: def.longitude,
          accuracy: def.accuracyMeters ?? null,
          source: 'saved_default',
        };
      }
    }
  }
  return { lat: null, lng: null, accuracy: null, source: null };
}

/** Human-readable variant label, e.g. "Size: M / Colour: Black". */
function variantLabelOf(variant: { attributes: string } | null): string | null {
  if (!variant) return null;
  return Object.entries(JSON.parse(variant.attributes) as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join(' / ') || null;
}

export async function POST(req: NextRequest) {
  // Orders created before a mid-checkout failure survive (each store's
  // transaction is independent) — the catch block reports them honestly.
  const createdOrders: { id: string; number: string; totalCents: number; paymentUrl?: string; paymentKind?: string; store?: { name: string; payoutProvider: string | null; payoutLink: string | null; payoutNote: string | null; payfastReady?: boolean; ozowReady?: boolean; yocoReady?: boolean; eft?: EftDetails | null } }[] = [];
  try {
    await bootstrap();
    const session = await requireUser();
    const rl = await rateLimitShared(`checkout:${session.user.id}`, 10, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const body = (await req.json()) as CheckoutBody;
    const buyerName = String(body.buyerName ?? '').trim();
    const buyerEmail = (String(body.buyerEmail ?? '').trim() || session.user.email).toLowerCase();
    const buyerPhone = String(body.buyerPhone ?? '').trim();
    const address = String(body.address ?? '').trim();
    const shippingCode = String(body.shippingCode ?? 'standard');
    const idempotencyKey = String(body.idempotencyKey ?? '') || null;

    const errors: string[] = [];
    if (buyerName.length < 2) errors.push('Enter the recipient name');
    if (buyerName.length > 120) errors.push('The recipient name is too long (120 characters at most)');
    if (buyerEmail.length > 254) errors.push('The email address is too long');
    if (buyerPhone.length > 30) errors.push('The contact number is too long');
    if (address.length > 600) errors.push('The delivery address is too long (600 characters at most)');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) errors.push('Enter a valid email address');
    if (buyerPhone.replace(/\D/g, '').length < 9) errors.push('Enter a valid contact number');
    if (address.length < 10) errors.push('Enter the full delivery address');
    if (errors.length > 0) return Response.json({ error: errors.join('. ') }, { status: 400 });

    if (idempotencyKey) {
      // Duplicate check — scoped to THIS buyer (another user's key must never
      // reveal their order) and projected to the same safe shape the normal
      // response uses (encrypted processor keys are never returned by any API).
      // Multi-store checkouts store "<key>:<storeId>" per order, so the
      // retry lookup matches ALL of them — the confirmation screen must
      // show every order the original attempt created, not just the first.
      const existing = await db.order.findMany({
        where: {
          buyerId: session.user.id,
          OR: [{ idempotencyKey }, { idempotencyKey: { startsWith: `${idempotencyKey}:` } }],
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, number: true, totalCents: true, status: true, paymentStatus: true, paymentRef: true,
          store: { select: { id: true, name: true, ...STORE_PAYMENT_SELECT } },
        },
      });
      if (existing.length > 0) {
        return Response.json({ ok: true, duplicate: true, payments: { payfast: payfastEnabled(), ggpay: ggpayAcceptsCards() }, orders: existing.map((o) => ({ id: o.id, number: o.number, totalCents: o.totalCents, store: publicPaymentStore(o.store, o, { showEft: true }) })) });
      }
    }

    const cartItems = await db.cartItem.findMany({
      where: { userId: session.user.id },
      include: {
        product: { include: { store: true, images: { orderBy: { position: 'asc' }, take: 1 }, category: { select: { slug: true } } } },
        variant: true,
      },
    });
    if (cartItems.length === 0) return Response.json({ error: 'Your cart is empty.' }, { status: 400 });

    // Recompute every line server-side and validate availability.
    const lines = cartItems.map((item) => {
      const unit = item.variant?.priceCents ?? item.product.salePriceCents ?? item.product.priceCents;
      const available = item.variant ? item.variant.stock : item.product.stock;
      return { item, unit, available };
    });
    // Store/product/variant status is re-checked at the last moment: a store
    // suspended after the item was added to the cart cannot take a NEW paid
    // order, and an inactive variant can never be decremented.
    const unavailable = lines.filter(
      (l) =>
        l.available <= 0 ||
        l.item.product.status !== 'approved' ||
        l.item.product.store.status !== 'active' ||
        (l.item.variant ? !l.item.variant.active : false),
    );
    if (unavailable.length > 0) {
      // Self-healing checkout: drop the dead rows from the stored cart before
      // refusing, so the buyer's very next attempt succeeds. Without this,
      // rows the cart view never showed kept failing every retry — buyers on
      // some devices were stuck in an endless "items are no longer available"
      // loop for products they could not even see.
      await db.cartItem.deleteMany({ where: { userId: session.user.id, id: { in: unavailable.map((u) => u.item.id) } } });
      const names = unavailable.map((u) => u.item.product.name).join(', ');
      return Response.json(
        { error: `${names} ${unavailable.length > 1 ? 'are' : 'is'} no longer available and ${unavailable.length > 1 ? 'were' : 'was'} removed from your cart. Please try again — your remaining items are ready for checkout.` },
        { status: 409 },
      );
    }
    const overdrawn = lines.filter((l) => l.item.quantity > l.available);
    if (overdrawn.length > 0) {
      // Quantities are clamped to the stock that actually remains, so the
      // retry succeeds — the buyer is never trapped adjusting a number the
      // cart already displayed as the clamped value.
      for (const o of overdrawn) {
        await db.cartItem.update({ where: { id: o.item.id }, data: { quantity: o.available } });
      }
      return Response.json(
        { error: `Only limited stock remains for: ${overdrawn.map((u) => u.item.product.name).join(', ')}. Quantities were adjusted to the remaining stock — please review your cart and try again.` },
        { status: 409 },
      );
    }

    // Group per store — one order per seller.
    const byStore = new Map<string, typeof lines>();
    for (const line of lines) {
      const arr = byStore.get(line.item.product.storeId) ?? [];
      arr.push(line);
      byStore.set(line.item.product.storeId, arr);
    }

    // Delivery pin — captured once; it rides with EVERY order so The Courier
    // Guy prices and routes the EXACT doorstep, not just the text address.
    const pin = await resolveDeliveryPin(session.user.id, address, body);
    const fallback = FALLBACK_RATES.find((r) => r.code === shippingCode) ?? FALLBACK_RATES[1];

    const provider = getPaymentProvider('bank_transfer');
    // In-system card payments (Yoco Checkout API — Mastercard & Visa): the
    // success landing is our verify-and-redirect handler; Yoco only counts as
    // paid after server-side verification, never from the browser redirect.
    const baseUrl = (process.env.NEXTAUTH_URL ?? new URL(req.url).origin).replace(/\/$/, '');

    for (const [storeId, storeLines] of byStore) {
      const store = storeLines[0].item.product.store;

      // Shipping quote PER STORE (Courier Guy first, transparent fallback
      // table): each seller ships from their own origin with their own
      // parcels, so every order carries the delivery fee for ITS leg. A
      // multi-seller cart must never charge every store the first store's
      // rate. Quote failure keeps the fallback table — checkout never
      // blocks (spec #40).
      let shippingCents = Math.round(fallback.price * 100);
      let shippingLabel = fallback.label;
      let shippingEta = fallback.eta;
      let shippingProvider = fallback.provider;
      try {
        // Real parcels: one per unit, built from what this seller declared
        // for the product (weight + box size) — The Courier Guy charges on
        // the greater of actual vs volumetric weight, so both must be true
        // to the shipment for the order's delivery charge to be right.
        const parcels = storeLines.flatMap((l) =>
          Array.from({ length: Math.min(20, l.item.quantity) }, () => ({
            weightKg: Math.max(0.1, l.item.product.weightGrams / 1000),
            lengthCm: l.item.product.lengthCm,
            widthCm: l.item.product.widthCm,
            heightCm: l.item.product.heightCm,
          })),
        ).slice(0, 20);
        const quotes = await getShippingRates({
          sellerLocation: store.location,
          buyerAddress: address,
          buyerLat: pin.lat ?? undefined,
          buyerLng: pin.lng ?? undefined,
          parcels,
        });
        const match = quotes.find((r) => r.code === shippingCode) ?? quotes[0];
        if (match) {
          shippingCents = Math.round(match.price * 100);
          shippingLabel = match.label;
          shippingEta = match.eta;
          shippingProvider = match.provider;
        }
      } catch {
        // quote failure keeps the fallback table — checkout never blocks
      }

      const subtotalCents = storeLines.reduce((sum, l) => sum + l.unit * l.item.quantity, 0);
      const totalCents = subtotalCents + shippingCents;
      // A collision on the unique order number rolls the whole transaction
      // back (stock untouched), so it is simply retried with a fresh number.
      const order = await withFreshOrderNumber((number) => db.$transaction(async (tx) => {
        // Concurrency-safe inventory: guarded decrement, verified via count.
        for (const l of storeLines) {
          const updated = l.item.variant
            ? await tx.productVariant.updateMany({ where: { id: l.item.variantId!, stock: { gte: l.item.quantity }, active: true }, data: { stock: { decrement: l.item.quantity } } })
            : await tx.product.updateMany({ where: { id: l.item.productId, stock: { gte: l.item.quantity } }, data: { stock: { decrement: l.item.quantity } } });
          if (updated.count === 0) throw new StockError(l.item.product.name);
        }

        const created = await tx.order.create({
          data: {
            number,
            buyerId: session.user.id,
            buyerName,
            buyerEmail,
            buyerPhone,
            address,
            shippingMethod: `${shippingLabel} (${shippingProvider})`,
            shippingCents,
            subtotalCents,
            totalCents,
            status: 'pending_payment',
            paymentStatus: 'awaiting_payment',
            // Per-store idempotency key: a multi-seller checkout creates one
            // order PER STORE, and the column is unique — the same raw key on
            // every order made the second store's creation throw and roll
            // back, stranding every store after the first.
            idempotencyKey: idempotencyKey ? `${idempotencyKey}:${storeId}` : null,
            deliveryLat: pin.lat,
            deliveryLng: pin.lng,
            deliveryAccuracyMeters: pin.accuracy,
            deliveryPinSource: pin.source,
            storeId,
            items: {
              create: storeLines.map((l) => ({
                productId: l.item.productId,
                variantId: l.item.variantId,
                storeId,
                name: l.item.product.name,
                variantLabel: variantLabelOf(l.item.variant),
                quantity: l.item.quantity,
                unitPriceCents: l.unit,
              })),
            },
            events: {
              create: {
                status: 'pending_payment',
                note: `Order placed via ${provider.label}${pin.lat !== null && pin.lng !== null ? ` — courier pin ${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}` : ''}`,
                actorId: session.user.id,
              },
            },
          },
        });

        for (const l of storeLines) {
          await tx.productEvent.create({ data: { productId: l.item.productId, type: 'purchase', userId: session.user.id } });
        }
        // Remove exactly the cart rows that were purchased — a different
        // variant of the same product must survive.
        await tx.cartItem.deleteMany({ where: { userId: session.user.id, id: { in: storeLines.map((l) => l.item.id) } } });
        return created;
      }));

      createdOrders.push({
        id: order.id, number: order.number, totalCents: order.totalCents,
        // So the confirmation screen offers only the rails that can really
        // take this money (seller's PayFast / Ozow / Yoco, payment page, and
        // the seller's EFT bank details for this buyer's unpaid order).
        store: (({ name, payoutProvider, payoutLink, payoutNote, payfastReady, ozowReady, yocoReady, eft }) => ({ name, payoutProvider, payoutLink, payoutNote, payfastReady, ozowReady, yocoReady, eft }))(publicPaymentStore(store, order, { showEft: true })),
      });

      // In-system card checkout: when the seller connected Yoco (or takes
      // Mastercard cards via Yoco), create a real Yoco session for THIS order
      // with the exact total. Fail-safe: any Yoco problem degrades to the
      // existing bank-transfer / payment-link options — checkout never blocks.
      if (['yoco', 'mastercard'].includes(store.payoutProvider ?? '') && store.yocoSecretKey) {
        const secret = decryptSecret(store.yocoSecretKey);
        // Live keys only on the live marketplace (a test key confirms orders
        // paid with Yoco's public test cards while no money moves).
        if (secret && yocoKeyUsable(secret)) {
          try {
            const session = await yocoCreateCheckout(secret, {
              amountCents: order.totalCents,
              orderNumber: order.number,
              storeName: store.name,
              successUrl: `${baseUrl}/api/payments/yoco/return?number=${encodeURIComponent(order.number)}`,
              cancelUrl: `${baseUrl}/#/orders`,
            });
            if (session) {
              await db.order.update({ where: { id: order.id }, data: { yocoCheckoutId: session.id } });
              createdOrders[createdOrders.length - 1].paymentUrl = session.redirectUrl;
              createdOrders[createdOrders.length - 1].paymentKind = 'yoco_card';
            }
          } catch (e) {
            console.error('yoco checkout session skipped:', e instanceof Error ? e.message : e);
          }
        }
      }

      // Purchase is the strongest learning signal for the recommendation engine.
      for (const l of storeLines) {
        void recordInteraction({
          productId: l.item.productId,
          type: 'purchase',
          userId: session.user.id,
          catSlug: l.item.product.category?.slug ?? null,
          brand: l.item.product.brand,
          priceCents: l.unit,
        }).catch(() => undefined);
      }

      // Payment intent + transactional emails (non-blocking).
      const intent = await provider.createPayment({ number: order.number, totalCents: order.totalCents, currency: order.currency });
      const itemsText = storeLines
        .map((l) => `<p style="margin:2px 0;">${l.item.quantity} × ${escapeHtml(l.item.product.name)}${l.item.variant ? ` (${escapeHtml(variantLabelOf(l.item.variant))})` : ''} — ${formatMoney(l.unit * l.item.quantity)}</p>`)
        .join('');
      void Promise.allSettled([
        (async () => {
          const { sendOrderConfirmation, sendSellerNewOrder, eftInstructionsHtml } = await import('@/lib/email');
          await sendOrderConfirmation({
            to: buyerEmail, buyerName, orderNumber: order.number, storeName: store.name,
            itemsText, total: formatMoney(order.totalCents),
            // The real payee: the seller's EFT details (when on file) plus
            // the pay-online pointer — not a promise of details never sent.
            instructionsHtml: eftInstructionsHtml(eftDetailsFor(store, order), order.number, formatMoney(order.totalCents)) || intent.instructionsHtml,
          });
          // Seller notice goes to the SELLER only (it used to fall back to
          // the buyer's address when the seller's could not be read).
          const sellerEmail = store.userId ? (await db.user.findUnique({ where: { id: store.userId }, select: { email: true } }))?.email : null;
          if (sellerEmail) {
            await sendSellerNewOrder({
              to: sellerEmail,
              storeName: store.name, orderNumber: order.number, itemsText, total: formatMoney(order.totalCents),
              pinUrl: pin.lat !== null && pin.lng !== null ? `https://www.google.com/maps?q=${pin.lat.toFixed(6)},${pin.lng.toFixed(6)}` : undefined,
            });
          }
        })(),
      ]);
      await audit({ actorId: session.user.id, actorEmail: buyerEmail, action: 'order_created', target: order.number, detail: `${formatMoney(order.totalCents)} · ${store.name}` });

      // In-app notifications for buyer and seller (best-effort, never block).
      void notify({
        userId: session.user.id,
        type: 'order_placed',
        title: 'Order placed',
        body: `Order ${order.number} with ${store.name} was received — total ${formatMoney(order.totalCents)}.`,
        link: '/orders',
      });
      if (store.userId) {
        void notify({
          userId: store.userId,
          type: 'new_order',
          title: 'New order received',
          body: `Order ${order.number} — ${formatMoney(order.totalCents)}. Confirm payment and dispatch it from your dashboard.`,
          link: '/dashboard',
        });
      }
    }

    return Response.json({ ok: true, orders: createdOrders, payments: { payfast: payfastEnabled(), ggpay: ggpayAcceptsCards() } }, { status: 201 });
  } catch (e) {
    if (e instanceof StockError) {
      // Multi-store checkout: stores processed BEFORE this failure already
      // committed their orders atomically (stock decremented, cart rows
      // removed). Report the successful orders AND the failure honestly, so
      // the buyer is never left wondering where the rest of their cart went.
      if (createdOrders.length > 0) {
        return Response.json({
          ok: true,
          orders: createdOrders,
          partialFailure: {
            product: e.productName,
            message: `Stock for "${e.productName}" was just taken by another buyer. Your other order(s) above were placed — the remaining items are still in your cart to check out again.`,
          },
          payments: { payfast: payfastEnabled(), ggpay: ggpayAcceptsCards() },
        }, { status: 201 });
      }
      return Response.json({ error: `Stock for "${e.productName}" was just taken by another buyer. Please review your cart.` }, { status: 409 });
    }
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    if (e instanceof Error && e.message.includes('Unique constraint')) {
      return Response.json({ error: 'This checkout was already submitted.' }, { status: 409 });
    }
    console.error('checkout error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Checkout could not be completed. Please try again.' }, { status: 500 });
  }
}

/** Runs `create` with a fresh order number, retrying (up to 3 more times)
 *  only when the unique `number` column collides — any other error,
 *  including an idempotency-key duplicate, is rethrown unchanged. */
async function withFreshOrderNumber<T>(create: (number: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await create(orderNumber());
    } catch (e) {
      const err = e as { code?: string; meta?: { target?: unknown } };
      const target = err.code === 'P2002' ? String(err.meta?.target ?? '') : '';
      if (attempt < 3 && /(^|[^a-z])number/i.test(target) && !/idempotency/i.test(target)) continue;
      throw e;
    }
  }
}

class StockError extends Error {
  constructor(public productName: string) {
    super(`stock conflict: ${productName}`);
  }
}
