import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { recordInteraction } from '@/lib/recommender';

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
            store: { select: { id: true, slug: true, name: true, location: true } },
            images: { orderBy: { position: 'asc' }, take: 1, select: { dataUrl: true } },
          },
        },
        variant: true,
      },
    });

    const lines = items
      .filter((i) => i.product.status === 'approved')
      .map((i) => {
        const variantStock = i.variant ? i.variant.stock : i.product.stock;
        const unit = i.variant?.priceCents ?? i.product.salePriceCents ?? i.product.priceCents;
        return {
          id: i.id,
          productId: i.productId,
          variantId: i.variantId,
          quantity: Math.min(i.quantity, Math.max(variantStock, 0)),
          name: i.product.name,
          image: i.product.images[0]?.dataUrl ?? i.variant?.imageData ?? null,
          unitPriceCents: unit,
          stock: variantStock,
          slug: i.product.slug,
          store: i.product.store,
        };
      })
      .filter((l) => l.quantity > 0 || l.stock > 0);

    return Response.json({ lines });
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
    const body = (await req.json()) as { productId?: string; variantId?: string | null; quantity?: number };
    const productId = String(body.productId ?? '');
    const variantId = body.variantId ?? null;
    const quantity = Math.max(1, Math.min(99, Math.floor(Number(body.quantity ?? 1)) || 1));

    const product = await db.product.findUnique({
      where: { id: productId },
      select: { id: true, status: true, stock: true, brand: true, priceCents: true, salePriceCents: true, category: { select: { slug: true } } },
    });
    if (!product || product.status !== 'approved') return Response.json({ error: 'This product is not available.' }, { status: 404 });

    let available = product.stock;
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
    const body = (await req.json()) as { itemId?: string; quantity?: number };
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
