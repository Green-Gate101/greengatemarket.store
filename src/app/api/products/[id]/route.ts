import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { removeProduct } from '@/lib/algolia';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const existing = await db.product.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Product not found' }, { status: 404 });

    const orderItems = await db.orderItem.count({ where: { productId: id } });
    if (orderItems > 0) {
      // Preserve order history — retire the listing instead of destroying it.
      await db.product.update({ where: { id }, data: { stock: 0 } });
      await removeProduct(id);
      return NextResponse.json({ retired: true, message: 'Product has existing orders and was retired from the storefront (stock set to zero).' });
    }

    await db.product.delete({ where: { id } });
    await removeProduct(id);
    return NextResponse.json({ deleted: true });
  } catch (e) {
    console.error('DELETE /api/products/[id] error:', e);
    return NextResponse.json({ error: 'Failed to delete product' }, { status: 500 });
  }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const product = await db.product.findUnique({
      where: { id },
      include: { seller: { select: { id: true, storeName: true, location: true } } },
    });
    if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    return NextResponse.json({ product });
  } catch (e) {
    console.error('GET /api/products/[id] error:', e);
    return NextResponse.json({ error: 'Failed to load product' }, { status: 500 });
  }
}
