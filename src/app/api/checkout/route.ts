import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { getShippingRates, FALLBACK_RATES } from '@/lib/shipping';
import { getPaymentProvider } from '@/lib/payments';
import { orderNumber } from '@/lib/password';
import { audit } from '@/lib/audit';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';
import { bootstrap } from '@/lib/bootstrap';
import { formatMoney } from '@/lib/types';

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
}

export async function POST(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireUser();
    const rl = rateLimit(`checkout:${session.user.id}`, 10, 3600_000);
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) errors.push('Enter a valid email address');
    if (buyerPhone.replace(/\D/g, '').length < 9) errors.push('Enter a valid contact number');
    if (address.length < 10) errors.push('Enter the full delivery address');
    if (errors.length > 0) return Response.json({ error: errors.join('. ') }, { status: 400 });

    if (idempotencyKey) {
      const existing = await db.order.findUnique({ where: { idempotencyKey } });
      if (existing) {
        return Response.json({ ok: true, orders: [existing], duplicate: true });
      }
    }

    const cartItems = await db.cartItem.findMany({
      where: { userId: session.user.id },
      include: {
        product: { include: { store: true, images: { orderBy: { position: 'asc' }, take: 1 } } },
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
    const unavailable = lines.filter((l) => l.available <= 0 || l.item.product.status !== 'approved');
    if (unavailable.length > 0) {
      return Response.json(
        { error: `Some items are no longer available: ${unavailable.map((u) => u.item.product.name).join(', ')}. Please review your cart.` },
        { status: 409 },
      );
    }
    const overdrawn = lines.filter((l) => l.item.quantity > l.available);
    if (overdrawn.length > 0) {
      return Response.json(
        { error: `Only limited stock remains for: ${overdrawn.map((u) => u.item.product.name).join(', ')}. Please adjust quantities.` },
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

    // Shipping quote (Courier Guy first, transparent fallback table).
    const fallback = FALLBACK_RATES.find((r) => r.code === shippingCode) ?? FALLBACK_RATES[1];
    let shippingCents = Math.round(fallback.price * 100);
    let shippingLabel = fallback.label;
    let shippingEta = fallback.eta;
    let shippingProvider = fallback.provider;
    try {
      const firstStore = [...byStore.values()][0][0].item.product.store;
      const quotes = await getShippingRates({ sellerLocation: firstStore.location, buyerAddress: address });
      const match = quotes.find((r) => r.code === shippingCode) ?? quotes[0];
      if (match) {
        shippingCents = Math.round(match.price * 100);
        shippingLabel = match.label;
        shippingEta = match.eta;
        shippingProvider = match.provider;
      }
    } catch {
      // quote failure keeps the fallback table — checkout never blocks (spec #40)
    }

    const provider = getPaymentProvider('bank_transfer');
    const createdOrders: { id: string; number: string; totalCents: number }[] = [];

    for (const [storeId, storeLines] of byStore) {
      const subtotalCents = storeLines.reduce((sum, l) => sum + l.unit * l.item.quantity, 0);
      const totalCents = subtotalCents + shippingCents;
      const store = storeLines[0].item.product.store;
      const number = orderNumber();

      const order = await db.$transaction(async (tx) => {
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
            idempotencyKey,
            storeId,
            items: {
              create: storeLines.map((l) => ({
                productId: l.item.productId,
                variantId: l.item.variantId,
                storeId,
                name: l.item.product.name,
                variantLabel: l.item.variant ? Object.entries(JSON.parse(l.item.variant.attributes)).map(([k, v]) => `${k}: ${v}`).join(' / ') : null,
                quantity: l.item.quantity,
                unitPriceCents: l.unit,
              })),
            },
            events: { create: { status: 'pending_payment', note: `Order placed via ${provider.label}`, actorId: session.user.id } },
          },
        });

        for (const l of storeLines) {
          await tx.productEvent.create({ data: { productId: l.item.productId, type: 'purchase', userId: session.user.id } });
        }
        await tx.cartItem.deleteMany({ where: { userId: session.user.id, productId: { in: storeLines.map((l) => l.item.productId) } } });
        return created;
      });

      createdOrders.push({ id: order.id, number: order.number, totalCents: order.totalCents });

      // Payment intent + transactional emails (non-blocking).
      const intent = await provider.createPayment({ number: order.number, totalCents: order.totalCents, currency: order.currency });
      const itemsText = storeLines
        .map((l) => `<p style="margin:2px 0;">${l.item.quantity} × ${l.item.product.name}${l.item.variant ? ` (${l.item.variantLabel ?? ''})` : ''} — ${formatMoney(l.unit * l.item.quantity)}</p>`)
        .join('');
      void Promise.allSettled([
        (async () => {
          const { sendOrderConfirmation, sendSellerNewOrder } = await import('@/lib/email');
          await sendOrderConfirmation({
            to: buyerEmail, buyerName, orderNumber: order.number, storeName: store.name,
            itemsText, total: formatMoney(order.totalCents), instructionsHtml: intent.instructionsHtml,
          });
          await sendSellerNewOrder({
            to: store.userId ? (await db.user.findUnique({ where: { id: store.userId }, select: { email: true } }))?.email ?? buyerEmail : buyerEmail,
            storeName: store.name, orderNumber: order.number, itemsText, total: formatMoney(order.totalCents),
          });
        })(),
      ]);
      await audit({ actorId: session.user.id, actorEmail: buyerEmail, action: 'order_created', target: order.number, detail: `${formatMoney(order.totalCents)} · ${store.name}` });
    }

    return Response.json({ ok: true, orders: createdOrders }, { status: 201 });
  } catch (e) {
    if (e instanceof StockError) {
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

class StockError extends Error {
  constructor(public productName: string) {
    super(`stock conflict: ${productName}`);
  }
}
