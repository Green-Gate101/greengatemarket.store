import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { sellingStoreWhere, storeCanSell } from '@/lib/subscription';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { recordInteraction } from '@/lib/recommender';
import { STORE_PAYMENT_SELECT, storeTakesOnlinePayment } from '@/lib/order-payment-options';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';
import { rateLimit, tooManyRequests } from '@/lib/rate-limit';
import { publicPickup } from '@/lib/pickup';

export const dynamic = 'force-dynamic';

/** Server-side cart. Totals are always recomputed at checkout — never trusted from the client. */
export async function GET() {
  try {
    await bootstrap();
    const session = await requireUser();
    const items = await db.cartItem.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        product: {
          select: {
            id: true, slug: true, name: true, priceCents: true, salePriceCents: true, stock: true, status: true,
            store: { select: { id: true, slug: true, name: true, location: true, status: true, billingExempt: true, accessUntil: true, pickupPaxiCents: true, pickupPaxiEta: true, pickupPudoCents: true, pickupPudoEta: true } },
            // Photo by address (edge-cached file) — the cart used to carry each photo inline.
            images: { orderBy: { position: 'asc' }, take: 1, select: { id: true } },
          },
        },
        variant: true,
      },
    });

    // Cart truth-sync (fixes stuck checkouts on some devices): the checkout
    // API validates EVERY stored cart row, while the view below hides dead
    // ones — rows for archived products, suspended stores, inactive variants
    // or zero stock used to rot invisibly in the database, so checkout kept
    // failing with "some items are no longer available" for products the
    // buyer could not even see. Dead rows are now deleted and quantities
    // larger than the remaining stock are clamped, so the stored cart always
    // matches what this view displays and what checkout validates.
    const removed: string[] = [];
    const deadIds: string[] = [];
    const clamped: { id: string; quantity: number }[] = [];
    for (const i of items) {
      const available = i.variant ? i.variant.stock : i.product.stock;
      const dead =
        i.product.status !== 'approved' ||
        !storeCanSell(i.product.store) ||
        (i.variant ? !i.variant.active || available <= 0 : available <= 0);
      if (dead) {
        deadIds.push(i.id);
        removed.push(i.product.name);
      } else if (i.quantity > available) {
        clamped.push({ id: i.id, quantity: available });
      }
    }
    if (deadIds.length > 0) {
      await db.cartItem.deleteMany({ where: { userId: session.user.id, id: { in: deadIds } } });
    }
    for (const c of clamped) {
      await db.cartItem.update({ where: { id: c.id }, data: { quantity: c.quantity } });
    }

    // Stores in this cart that have a usable discount code: the checkout shows
    // the code box only when at least one of them does.
    const cartStoreIds = [...new Set(items.map((i) => i.product.store.id))];
    const now = new Date();
    const storesWithCodes = new Set(cartStoreIds.length === 0 ? [] : (await db.discountCode.findMany({
      where: { storeId: { in: cartStoreIds }, active: true, disabledByAdmin: false, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { storeId: true, maxUses: true, usedCount: true },
    })).filter((c) => c.maxUses === null || c.usedCount < c.maxUses).map((c) => c.storeId));
    const lines = items
      .filter((i) => !deadIds.includes(i.id))
      .map((i) => {
        const variantStock = i.variant ? i.variant.stock : i.product.stock;
        const unit = i.variant?.priceCents ?? i.product.salePriceCents ?? i.product.priceCents;
        const storedQty = clamped.find((c) => c.id === i.id)?.quantity ?? i.quantity;
        return {
          id: i.id,
          productId: i.productId,
          variantId: i.variantId,
          quantity: Math.min(storedQty, Math.max(variantStock, 0)),
          name: i.product.name,
          image: i.product.images[0] ? `/api/images/${i.product.images[0].id}` : i.variant?.imageData ?? null,
          unitPriceCents: unit,
          stock: variantStock,
          slug: i.product.slug,
          // Public store fields only (billing dates stay on the server).
          store: { id: i.product.store.id, slug: i.product.store.slug, name: i.product.store.name, location: i.product.store.location, status: i.product.store.status, pickup: publicPickup(i.product.store), hasDiscounts: storesWithCodes.has(i.product.store.id) },
        };
      })
      .filter((l) => l.quantity > 0 || l.stock > 0);

    // `removed` lets the client tell the buyer which dead lines were dropped —
    // items must never vanish without a word.
    return Response.json({ lines, removed });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('cart GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load your cart.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireUser();
    // Generous per-account ceiling on changes (no person comes close; stops scripted floods).
    const writes = rateLimit(`account-writes:${session.user.id}`, 300, 60_000);
    if (!writes.allowed) return tooManyRequests(writes);
    const body = (await readJsonObject(req)) as { productId?: string; variantId?: string | null; quantity?: number } | null;
    if (!body) return invalidJsonBody();
    const productId = String(body.productId ?? '');
    const variantId = body.variantId ?? null;
    const quantity = Math.max(1, Math.min(99, Math.floor(Number(body.quantity ?? 1)) || 1));

    const product = await db.product.findUnique({
      where: { id: productId },
      select: { id: true, status: true, stock: true, brand: true, priceCents: true, salePriceCents: true, category: { select: { slug: true } }, store: { select: { status: true, billingExempt: true, accessUntil: true } } },
    });
    // Only ACTIVE stores can take new cart additions — a store suspended
    // (or paused for an unpaid subscription) after the visitor browsed it
    // must not keep selling.
    if (!product || product.status !== 'approved' || !storeCanSell(product.store)) return Response.json({ error: 'This product is not available.' }, { status: 404 });
    // Buyers pay only through the seller's connected processor — a store
    // without one cannot sell (checkout would refuse the order anyway).
    const payStore = await db.product.findUnique({ where: { id: productId }, select: { store: { select: { id: true, name: true, ...STORE_PAYMENT_SELECT } } } });
    if (!payStore || !storeTakesOnlinePayment(payStore.store)) {
      return Response.json({ error: 'This seller has not connected an online payment processor yet, so this item can\'t be bought right now.' }, { status: 409 });
    }

    let available = product.stock;
    if (!variantId && (await db.productVariant.count({ where: { productId, active: true } })) > 0) {
      // 409, not 400: the guest-cart merge drops (and reports) a 409 line instead
      // of retrying it at every sign-in.
      return Response.json({ error: 'Choose a size or option on the product page first.' }, { status: 409 });
    }
    if (variantId) {
      const variant = await db.productVariant.findUnique({ where: { id: variantId } });
      if (!variant || variant.productId !== productId || !variant.active) {
        return Response.json({ error: 'This option is not available.' }, { status: 404 });
      }
      available = variant.stock;
    }
    if (available <= 0) return Response.json({ error: 'This item is out of stock.' }, { status: 409 });

    // Compound unique contains a nullable column — query with findFirst/update instead of upsert.
    const existing = await db.cartItem.findFirst({
      where: { userId: session.user.id, productId, variantId: variantId ?? null },
    });
    const nextQty = Math.min((existing?.quantity ?? 0) + quantity, available, 99);
    if (existing) {
      await db.cartItem.update({
        where: { id: existing.id },
        data: { quantity: nextQty },
      });
    } else {
      await db.cartItem.create({
        data: { userId: session.user.id, productId, variantId, quantity: nextQty },
      });
    }

    db.productEvent.create({ data: { productId, type: 'cart', userId: session.user.id } }).catch(() => undefined);
    void recordInteraction({
      productId,
      type: 'cart',
      userId: session.user.id,
      catSlug: product.category?.slug ?? null,
      brand: product.brand,
      priceCents: product.salePriceCents ?? product.priceCents,
    }).catch(() => undefined);

    const count = await db.cartItem.count({ where: { userId: session.user.id } });
    return Response.json({ ok: true, count });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('cart POST error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not add to cart.' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await requireUser();
    // Generous per-account ceiling on changes (no person comes close; stops scripted floods).
    const writes = rateLimit(`account-writes:${session.user.id}`, 300, 60_000);
    if (!writes.allowed) return tooManyRequests(writes);
    const body = (await readJsonObject(req)) as { itemId?: string; quantity?: number } | null;
    if (!body) return invalidJsonBody();
    const itemId = String(body.itemId ?? '');
    const quantity = Math.floor(Number(body.quantity ?? 0));

    const item = await db.cartItem.findUnique({ where: { id: itemId } });
    if (!item || item.userId !== session.user.id) return Response.json({ error: 'Cart item not found' }, { status: 404 });

    if (quantity <= 0) {
      await db.cartItem.delete({ where: { id: itemId } });
      return Response.json({ ok: true, removed: true });
    }
    const clamped = Math.min(quantity, 99);
    await db.cartItem.update({ where: { id: itemId }, data: { quantity: clamped } });
    return Response.json({ ok: true });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('cart PATCH error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not update the cart.' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await requireUser();
    // Generous per-account ceiling on changes (no person comes close; stops scripted floods).
    const writes = rateLimit(`account-writes:${session.user.id}`, 300, 60_000);
    if (!writes.allowed) return tooManyRequests(writes);
    const itemId = new URL(req.url).searchParams.get('itemId') ?? '';
    const item = await db.cartItem.findUnique({ where: { id: itemId } });
    if (!item || item.userId !== session.user.id) return Response.json({ error: 'Cart item not found' }, { status: 404 });
    await db.cartItem.delete({ where: { id: itemId } });
    return Response.json({ ok: true });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('cart DELETE error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not remove the item.' }, { status: 500 });
  }
}
