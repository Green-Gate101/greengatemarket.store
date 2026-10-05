import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureSeed } from '@/lib/seed';
import { rateByCode } from '@/lib/shipping';
import { sendOrderConfirmation } from '@/lib/email';
import { formatZAR } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface IncomingItem {
  productId: string;
  quantity: number;
}

export async function GET(req: NextRequest) {
  try {
    await ensureSeed();
    const { searchParams } = new URL(req.url);
    const sellerId = searchParams.get('sellerId')?.trim() ?? '';
    const limit = Math.min(Number(searchParams.get('limit') ?? 25) || 25, 100);
    if (!sellerId) return NextResponse.json({ error: 'sellerId is required' }, { status: 400 });

    const orders = await db.order.findMany({
      where: { sellerId },
      include: { items: { include: { product: { select: { id: true, name: true, imageData: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return NextResponse.json({ orders });
  } catch (e) {
    console.error('GET /api/orders error:', e);
    return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const buyerName = String(body.buyerName ?? '').trim();
    const buyerEmail = String(body.buyerEmail ?? '').trim();
    const buyerPhone = String(body.buyerPhone ?? '').trim();
    const address = String(body.address ?? '').trim();
    const shippingMethod = String(body.shippingMethod ?? 'standard').trim();
    const items: IncomingItem[] = Array.isArray(body.items) ? body.items : [];

    const errors: string[] = [];
    if (buyerName.length < 2) errors.push('Full name is required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) errors.push('A valid email is required for your receipt');
    if (buyerPhone.replace(/\D/g, '').length < 9) errors.push('A valid phone number is required for courier delivery');
    if (address.length < 10) errors.push('A full delivery address is required');
    if (items.length === 0) errors.push('Your cart is empty');
    if (errors.length > 0) return NextResponse.json({ error: errors.join('; ') }, { status: 400 });

    for (const item of items) {
      if (!item.productId || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) {
        return NextResponse.json({ error: 'Invalid cart quantities' }, { status: 400 });
      }
    }

    const products = await db.product.findMany({
      where: { id: { in: items.map((i) => i.productId) } },
      include: { seller: true },
    });
    if (products.length !== items.length) {
      return NextResponse.json({ error: 'One or more products are no longer available' }, { status: 409 });
    }

    // Validate stock across the whole cart before writing anything.
    for (const item of items) {
      const product = products.find((p) => p.id === item.productId)!;
      if (product.stock < item.quantity) {
        return NextResponse.json({ error: `Only ${product.stock} × ${product.name} left in stock` }, { status: 409 });
      }
    }

    const rate = rateByCode(shippingMethod);

    // One order per seller, exactly like a real multi-vendor marketplace.
    const bySeller = new Map<string, typeof items>();
    for (const item of items) {
      const product = products.find((p) => p.id === item.productId)!;
      const list = bySeller.get(product.sellerId) ?? [];
      list.push(item);
      bySeller.set(product.sellerId, list);
    }

    const created = [];
    for (const [sellerId, sellerItems] of bySeller) {
      const lines = sellerItems.map((item) => {
        const product = products.find((p) => p.id === item.productId)!;
        return { productId: product.id, quantity: item.quantity, unitPrice: product.price };
      });
      const subtotal = Math.round(lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0) * 100) / 100;
      const total = Math.round((subtotal + rate.price) * 100) / 100;

      const order = await db.order.create({
        data: {
          sellerId,
          buyerName,
          buyerEmail,
          buyerPhone,
          address,
          shippingMethod: rate.code,
          shippingCost: rate.price,
          subtotal,
          total,
          status: 'paid',
          items: { create: lines },
        },
        include: { items: { include: { product: { select: { id: true, name: true, imageData: true } } } }, seller: { select: { storeName: true } } },
      });
      created.push(order);

      await Promise.all(
        lines.map((l) =>
          db.product.update({ where: { id: l.productId }, data: { stock: { decrement: l.quantity } } }),
        ),
      );

      const itemsText = order.items
        .map((it) => `<p style="margin:2px 0;">${it.quantity} × ${it.product.name} — ${formatZAR(it.unitPrice * it.quantity)}</p>`)
        .join('');
      sendOrderConfirmation({
        to: buyerEmail,
        buyerName,
        orderId: order.id.slice(-8).toUpperCase(),
        storeName: order.seller.storeName,
        itemsText,
        total: formatZAR(total),
      }).catch(() => undefined);
    }

    return NextResponse.json({ orders: created }, { status: 201 });
  } catch (e) {
    console.error('POST /api/orders error:', e);
    return NextResponse.json({ error: 'Checkout failed. Please try again.' }, { status: 500 });
  }
}
