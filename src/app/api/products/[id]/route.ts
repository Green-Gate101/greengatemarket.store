import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireSellerTools, storeCanSell } from '@/lib/subscription';
import { bootstrap } from '@/lib/bootstrap';
import { requireStoreSeller, authErrorResponse } from '@/lib/auth';
import { removeProduct, indexProduct } from '@/lib/algolia';
import { audit } from '@/lib/audit';
import { STORE_PAYMENT_SELECT, storeTakesOnlinePayment } from '@/lib/order-payment-options';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';
import { rateLimit, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/** Load a product by id or slug — full public detail. */
async function findProduct(idOrSlug: string) {
  // Slugs always contain hyphens; database ids (cuids) never do.
  const bySlug = idOrSlug.includes('-');
  return db.product.findUnique({
    where: bySlug ? { slug: idOrSlug } : { id: idOrSlug },
    include: {
      store: { select: { id: true, slug: true, name: true, location: true, description: true, logoData: true, status: true } },
      category: { select: { id: true, slug: true, name: true } },
      images: { orderBy: { position: 'asc' }, select: { id: true, dataUrl: true, position: true } },
      variants: { where: { active: true }, orderBy: { sku: 'asc' } },
    },
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await bootstrap();
    const { id } = await ctx.params;
    const product = await findProduct(id);
    // Only live, admin-approved listings from ACTIVE stores are public.
    // Suspended stores (banned/suspended sellers) disappear from the detail
    // page too — not just from the catalogue grid.
    if (!product || !['approved'].includes(product.status) || product.store.status !== 'active') {
      return Response.json({ error: 'This product is not available.' }, { status: 404 });
    }
    // Paused while the store's subscription is unpaid (checked separately so
    // billing dates never ride along in the public product payload).
    const billing = await db.store.findUnique({ where: { id: product.store.id }, select: { status: true, billingExempt: true, accessUntil: true } });
    if (!billing || !storeCanSell(billing)) {
      return Response.json({ error: 'This product is not available.' }, { status: 404 });
    }

    // Can a buyer pay this seller? (processor connected — owner's rule)
    const payStore = await db.store.findUnique({ where: { id: product.store.id }, select: { id: true, name: true, ...STORE_PAYMENT_SELECT } });
    const canBuy = Boolean(payStore && storeTakesOnlinePayment(payStore));

    const [reviewAgg, reviews] = await Promise.all([
      db.review.aggregate({ where: { productId: product.id }, _avg: { rating: true }, _count: { rating: true } }),
      db.review.findMany({
        where: { productId: product.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { user: { select: { name: true } } },
      }),
    ]);

    // Views are recorded once, by the product page's own 'view' event
    // (POST /api/products/<id>/events — it also feeds the recommender).
    // Counting here as well doubled every view in seller analytics.

    const { variants, ...rest } = product;
    return Response.json({
      product: {
        ...rest,
        variants: variants.map((v) => ({ ...v, attributes: JSON.parse(v.attributes) })),
        ratingAvg: Number((reviewAgg._avg.rating ?? 0).toFixed(2)),
        ratingCount: reviewAgg._count.rating,
        canBuy,
        reviews: reviews.map((r) => ({
          id: r.id, rating: r.rating, title: r.title, body: r.body, verified: r.verified,
          createdAt: r.createdAt.toISOString(), authorName: r.user.name,
        })),
      },
    }, {
      // The same answer for every visitor (no session is read above), so the
      // edge serves it for a few seconds — as fresh as the catalogue grid —
      // instead of five database reads per product view. Stock and price are
      // checked again at add-to-cart and checkout.
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' },
    });
  } catch (e) {
    console.error('GET product error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load this product. Please try again.' }, { status: 500 });
  }
}

/** Resolve a product by id or slug (slugs contain hyphens; cuids never do). */
async function resolveProduct(idOrSlug: string) {
  return db.product.findUnique({
    where: idOrSlug.includes('-') ? { slug: idOrSlug } : { id: idOrSlug },
    include: { store: true },
  });
}

/** Seller updates their own product. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireStoreSeller();
    // Generous per-account ceiling on changes (no person comes close; stops scripted floods).
    const writes = rateLimit(`account-writes:${session.user.id}`, 300, 60_000);
    if (!writes.allowed) return tooManyRequests(writes);
    const { id } = await ctx.params;
    const product = await resolveProduct(id);
    if (!product) return Response.json({ error: 'Product not found' }, { status: 404 });
    if (product.store.userId !== session.user.id && session.user.role !== 'ADMIN') {
      return Response.json({ error: 'You can only edit your own products.' }, { status: 403 });
    }
    // The owner's listing tools need a running subscription; an administrator
    // moderating someone else's listing is never blocked.
    if (product.store.userId === session.user.id) await requireSellerTools(session.user.id);

    const body = (await readJsonObject(req)) as {
      name?: string; description?: string; price?: number; salePrice?: number | null;
      stock?: number; status?: string; brand?: string | null; tags?: string | null;
      variants?: { id?: string; stock?: number }[];
    } | null;
    if (!body) return invalidJsonBody();
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (name.length < 3 || name.length > 140) return Response.json({ error: 'Product name must be 3–140 characters' }, { status: 400 });
      data.name = name;
    }
    if (body.description !== undefined) {
      const d = String(body.description).trim();
      if (d.length < 20) return Response.json({ error: 'Description must be at least 20 characters' }, { status: 400 });
      data.description = d;
    }
    if (body.price !== undefined) {
      const p = Number(body.price);
      if (!Number.isFinite(p) || p <= 0) return Response.json({ error: 'Price must be greater than zero' }, { status: 400 });
      data.priceCents = Math.round(p * 100);
      // Lowering the price to (or below) the current sale price would leave a
      // "sale" that costs more than the normal price — end the sale instead.
      if (body.salePrice === undefined && product.salePriceCents !== null && product.salePriceCents >= (data.priceCents as number)) {
        data.salePriceCents = null;
      }
    }
    if (body.salePrice !== undefined) {
      if (body.salePrice === null) data.salePriceCents = null;
      else {
        const s = Number(body.salePrice);
        const base = (data.priceCents as number | undefined) ?? product.priceCents;
        if (!Number.isFinite(s) || s <= 0 || s >= base / 100) {
          return Response.json({ error: 'Sale price must be positive and below the normal price' }, { status: 400 });
        }
        data.salePriceCents = Math.round(s * 100);
      }
    }
    if (body.stock !== undefined) {
      const s = Number(body.stock);
      if (!Number.isInteger(s) || s < 0 || s > 1_000_000) return Response.json({ error: 'Stock must be a whole number from 0 to 1,000,000' }, { status: 400 });
      data.stock = s;
    }
    // Per-size restock: only this product's own sizes can be changed.
    const variantUpdates: { id: string; stock: number }[] = [];
    if (body.variants !== undefined) {
      if (!Array.isArray(body.variants) || body.variants.length > 50) return Response.json({ error: 'Send at most 50 sizes.' }, { status: 400 });
      for (const v of body.variants) {
        const s = Number(v?.stock);
        if (typeof v?.id !== 'string' || !Number.isInteger(s) || s < 0 || s > 1_000_000) {
          return Response.json({ error: 'Each size needs a whole-number stock from 0 to 1,000,000.' }, { status: 400 });
        }
        variantUpdates.push({ id: v.id, stock: s });
      }
    }
    if (body.status !== undefined) {
      if (!['approved', 'disabled'].includes(body.status)) {
        return Response.json({ error: 'Status must be approved or disabled' }, { status: 400 });
      }
      // Moderation is admin-owned: a product archived, rejected or explicitly
      // moderated (moderation note stamped) by marketplace administration can
      // never be re-approved by its seller — the seller may only toggle their
      // OWN enabled/disabled state. Admins keep full control (their PATCH
      // decides any state).
      if (
        body.status === 'approved' &&
        session.user.role !== 'ADMIN' &&
        (['archived', 'rejected'].includes(product.status) || Boolean(product.moderationNote))
      ) {
        return Response.json({ error: 'This product was removed by marketplace administration and cannot be re-listed.' }, { status: 403 });
      }
      data.status = body.status;
    }
    if (body.brand !== undefined) data.brand = body.brand === null ? null : String(body.brand).trim().slice(0, 80) || null;
    if (body.tags !== undefined) data.tags = body.tags === null ? null : String(body.tags).trim().slice(0, 500) || null;

    const updated = await db.$transaction(async (tx) => {
      for (const v of variantUpdates) {
        await tx.productVariant.updateMany({ where: { id: v.id, productId: product.id }, data: { stock: v.stock } });
      }
      return tx.product.update({ where: { id: product.id }, data });
    });
    if (data.status === 'disabled') await removeProduct(product.id);
    else if (data.name || data.priceCents || data.description) {
      await indexProduct({
        objectID: product.id, name: updated.name, description: updated.description,
        category: updated.categoryId ?? '', price: updated.priceCents / 100, sellerName: product.store.name,
      });
    }

    await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'product_updated', target: product.id });
    return Response.json({ ok: true });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('PATCH product error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not update the product.' }, { status: 500 });
  }
}

/** Soft delete (archive) — keeps order history intact. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireStoreSeller();
    // Generous per-account ceiling on changes (no person comes close; stops scripted floods).
    const writes = rateLimit(`account-writes:${session.user.id}`, 300, 60_000);
    if (!writes.allowed) return tooManyRequests(writes);
    const { id } = await ctx.params;
    const product = await resolveProduct(id);
    if (!product) return Response.json({ error: 'Product not found' }, { status: 404 });
    if (product.store.userId !== session.user.id && session.user.role !== 'ADMIN') {
      return Response.json({ error: 'You can only remove your own products.' }, { status: 403 });
    }
    const hasOrders = await db.orderItem.count({ where: { productId: product.id } });
    if (hasOrders > 0) {
      await db.product.update({ where: { id: product.id }, data: { status: 'archived' } });
    } else {
      await db.product.delete({ where: { id: product.id } });
    }
    await removeProduct(product.id);
    await audit({ actorId: session.user.id, actorEmail: session.user.email, action: hasOrders > 0 ? 'product_archived' : 'product_deleted', target: product.id });
    return Response.json({ ok: true });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('DELETE product error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not remove the product.' }, { status: 500 });
  }
}
