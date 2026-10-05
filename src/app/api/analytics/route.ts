import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureSeed } from '@/lib/seed';
import type { AnalyticsDto, CategorySlice, DailyPoint, OrderDto, TopProduct } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function GET(req: NextRequest) {
  try {
    await ensureSeed();
    const { searchParams } = new URL(req.url);
    const sellerIdParam = searchParams.get('sellerId')?.trim() ?? '';
    const sellerEmail = searchParams.get('sellerEmail')?.trim().toLowerCase() ?? '';

    // Resolve the seller by email when given: emails are stable across
    // database reseeds, database ids are not.
    let sellerId = sellerIdParam;
    if (sellerEmail) {
      const seller = await db.seller.findUnique({ where: { email: sellerEmail }, select: { id: true } });
      sellerId = seller?.id ?? 'none';
    }

    if (!sellerId) {
      // Marketplace-wide totals for the storefront trust bar.
      const [sellers, products, orders, units] = await Promise.all([
        db.seller.count(),
        db.product.count(),
        db.order.aggregate({ _count: { id: true }, _sum: { total: true } }),
        db.orderItem.aggregate({ _sum: { quantity: true } }),
      ]);
      return NextResponse.json({
        marketplace: {
          sellers,
          products,
          orders: orders._count.id,
          gmv: Math.round((orders._sum.total ?? 0) * 100) / 100,
          unitsSold: units._sum.quantity ?? 0,
        },
      });
    }

    const since = new Date();
    since.setDate(since.getDate() - 13);
    since.setHours(0, 0, 0, 0);

    const [orders, productAgg, productCount, lowStock, outOfStock] = await Promise.all([
      db.order.findMany({
        where: { sellerId, createdAt: { gte: since } },
        include: { items: { include: { product: { select: { id: true, name: true, imageData: true } } } } },
        orderBy: { createdAt: 'desc' },
      }),
      db.orderItem.findMany({
        where: { order: { sellerId } },
        include: { product: { select: { id: true, name: true, category: true, price: true } } },
      }),
      db.product.count({ where: { sellerId } }),
      db.product.count({ where: { sellerId, stock: { gt: 0, lte: 3 } } }),
      db.product.count({ where: { sellerId, stock: 0 } }),
    ]);

    const allOrdersCount = await db.order.count({ where: { sellerId } });

    // Daily series for the last 14 days.
    const dailyMap = new Map<string, DailyPoint>();
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = dayKey(d);
      dailyMap.set(key, {
        date: key,
        label: d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }),
        revenue: 0,
        orders: 0,
        units: 0,
      });
    }
    for (const order of orders) {
      const point = dailyMap.get(dayKey(new Date(order.createdAt)));
      if (!point) continue;
      point.revenue = Math.round((point.revenue + order.subtotal) * 100) / 100;
      point.orders += 1;
      point.units += order.items.reduce((s, it) => s + it.quantity, 0);
    }

    const revenue = orders.reduce((s, o) => s + o.subtotal, 0);
    const totals = {
      revenue: Math.round(revenue * 100) / 100,
      orders: orders.length,
      units: orders.reduce((s, o) => s + o.items.reduce((x, it) => x + it.quantity, 0), 0),
      avgOrderValue: orders.length > 0 ? Math.round((revenue / orders.length) * 100) / 100 : 0,
      products: productCount,
      lowStock,
      outOfStock,
    };

    const catMap = new Map<string, number>();
    const prodMap = new Map<string, TopProduct>();
    for (const item of productAgg) {
      if (!item.product) continue;
      const lineRevenue = item.unitPrice * item.quantity;
      catMap.set(item.product.category, (catMap.get(item.product.category) ?? 0) + lineRevenue);
      const existing = prodMap.get(item.product.id) ?? {
        productId: item.product.id,
        name: item.product.name,
        units: 0,
        revenue: 0,
      };
      existing.units += item.quantity;
      existing.revenue = Math.round((existing.revenue + lineRevenue) * 100) / 100;
      prodMap.set(item.product.id, existing);
    }
    const categories: CategorySlice[] = [...catMap.entries()]
      .map(([category, r]) => ({ category, revenue: Math.round(r * 100) / 100 }))
      .sort((a, b) => b.revenue - a.revenue);
    const topProducts = [...prodMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    const recentOrders: OrderDto[] = orders.slice(0, 12).map((o) => ({
      id: o.id,
      sellerId: o.sellerId,
      buyerName: o.buyerName,
      buyerEmail: o.buyerEmail,
      buyerPhone: o.buyerPhone,
      address: o.address,
      shippingMethod: o.shippingMethod,
      shippingCost: o.shippingCost,
      subtotal: o.subtotal,
      total: o.total,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
      items: o.items.map((it) => ({
        id: it.id,
        productId: it.productId,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        product: it.product ?? undefined,
      })),
    }));

    const analytics: AnalyticsDto & { allTimeOrders: number } = {
      totals,
      daily: [...dailyMap.values()],
      categories,
      topProducts,
      recentOrders,
      allTimeOrders: allOrdersCount,
    };
    return NextResponse.json(analytics);
  } catch (e) {
    console.error('GET /api/analytics error:', e);
    return NextResponse.json({ error: 'Failed to load analytics' }, { status: 500 });
  }
}
