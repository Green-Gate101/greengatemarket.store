import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { requireStoreSeller, authErrorResponse } from '@/lib/auth';
import { removeProduct, indexProduct } from '@/lib/algolia';
import { audit } from '@/lib/audit';

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

    const [reviewAgg, reviews] = await Promise.all([
      db.review.aggregate({ where: { productId: product.id }, _avg: { rating: true }, _count: { rating: true } }),
      db.review.findMany({
        where: { productId: product.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { user: { select: { name: true } } },
      }),
    ]);

    // View tracking: increment counter + real event row (best-effort).
    db.product.update({ where: { id: product.id }, data: { viewCount: { increment: 1 } } })
      .then(() => db.productEvent.create({ data: { productId: product.id, type: 'view' } }))
      .catch(() => undefined);

    const { variants, ...rest } = product;
    return Response.json({
      product: {
        ...rest,
        variants: variants.map((v) => ({ ...v, attributes: JSON.parse(v.attributes) })),
        ratingAvg: Number((reviewAgg._avg.rating ?? 0).toFixed(2)),
        ratingCount: reviewAgg._count.rating,
        reviews: reviews.map((r) => ({
          id: r.id, rating: r.rating, title: r.title, body: r.body, verified: r.verified,
          createdAt: r.createdAt.toISOString(), authorName: r.user.name,
        })),
      },
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
    const { id } = await ctx.params;
    const product = await resolveProduct(id);
    if (!product) return Response.json({ error: 'Product not found' }, { status: 404 });
    if (product.store.userId !== session.user.id && session.user.role !== 'ADMIN') {
      return Response.json({ error: 'You can only edit your own products.' }, { status: 403 });
    }

    const body = (await req.json()) as {
      name?: string; description?: string; price?: number; salePrice?: number | null;
      stock?: number; status?: string; brand?: string | null; tags?: string | null;
    };
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (name.length < 3) return Response.json({ error: 'Name must be at least 3 characters' }, { status: 400 });
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
      if (!Number.isInteger(s) || s < 0) return Response.json({ error: 'Stock must be a whole number ≥ 0' }, { status: 400 });
      data.stock = s;
    }
    if (body.status !== undefined) {
      if (!['approved', 'disabled'].includes(body.status)) {
        return Response.json({ error: 'Status must be approved or disabled' }, { status: 400 });
      }
      // Moderation is admin-owned: a product archived or rejected by the
      // marketplace administration can never be re-approved by its seller —
      // the seller may only toggle their OWN enabled/disabled state. Admins
      // keep full control (their PATCH decides any state).
      if (body.status === 'approved' && ['archived', 'rejected'].includes(product.status) && session.user.role !== 'ADMIN') {
        return Response.json({ error: 'This product was removed by marketplace administration and cannot be re-listed.' }, { status: 403 });
      }
      data.status = body.status;
    }
    if (body.brand !== undefined) data.brand = body.brand;
    if (body.tags !== undefined) data.tags = body.tags;

    const updated = await db.product.update({ where: { id: product.id }, data });
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
