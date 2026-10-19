import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireStoreSeller, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { SALE_STATUSES } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Seller analytics — every number comes from real orders and real product
 * events within the requested date range. No random data anywhere.
 * Ranges: today | 7 | 30 | 90 | 365 days, or explicit from/to (ISO date).
 */
export async function GET(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireStoreSeller();
    const store = await db.store.findUnique({ where: { userId: session.user.id } });
    if (!store) return Response.json({ error: 'No store found' }, { status: 404 });

    const sp = new URL(req.url).searchParams;
    const range = sp.get('range') ?? '30';
    let from: Date;
    let to = new Date();
    if (sp.get('from') && sp.get('to')) {
      from = new Date(String(sp.get('from')));
      to = new Date(String(sp.get('to')));
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return Response.json({ error: 'Invalid date range' }, { status: 400 });
      }
      to.setHours(23, 59, 59, 999);
    } else if (range === 'today') {
      from = new Date(); from.setHours(0, 0, 0, 0);
    } else {
      const days = [7, 30, 90, 365].includes(Number(range)) ? Number(range) : 30;
      from = new Date(to.getTime() - (days - 1) * 86400_000);
      from.setHours(0, 0, 0, 0);
    }

    const myProducts = await db.product.findMany({
      where: { storeId: store.id },
      select: { id: true, name: true, categoryId: true },
    });
    const productIds = myProducts.map((p) => p.id);
    const productName = new Map(myProducts.map((p) => [p.id, p.name]));

    // Real sales orders in range for this store.
    const orders = await db.order.findMany({
      where: { storeId: store.id, status: { in: SALE_STATUSES }, createdAt: { gte: from, lte: to } },
      include: { items: { where: { storeId: store.id } } },
    });

    const revenueCents = orders.reduce((s, o) => s + o.subtotalCents, 0);
    const units = orders.reduce((s, o) => s + o.items.reduce((k, i) => k + i.quantity, 0), 0);

    // Daily series (revenue, orders, units, product views) with zero-filled gaps.
    const daily: { date: string; label: string; revenue: number; orders: number; units: number; views: number }[] = [];
    const dayCount = Math.max(1, Math.min(400, Math.round((to.getTime() - from.getTime()) / 86400_000) + 1));
    for (let i = 0; i < dayCount; i++) {
      const d = new Date(from.getTime() + i * 86400_000);
      daily.push({
        date: d.toISOString().slice(0, 10),
        label: d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }),
        revenue: 0, orders: 0, units: 0, views: 0,
      });
    }
    const dayIndex = new Map(daily.map((d) => [d.date, d]));
    for (const o of orders) {
      const bucket = dayIndex.get(o.createdAt.toISOString().slice(0, 10));
      if (bucket) {
        bucket.revenue += o.subtotalCents / 100;
        bucket.orders += 1;
        bucket.units += o.items.reduce((s, i) => s + i.quantity, 0);
      }
    }

    // Real behavioural events in range for this store's products.
    let listEventsTotal = 0;
    let viewsTotal = 0;
    if (productIds.length > 0) {
      const listEvents = await db.productEvent.count({
        where: { productId: { in: productIds }, type: { in: ['cart', 'wishlist'] }, createdAt: { gte: from, lte: to } },
      });
      listEventsTotal = listEvents;
      const viewEvents = await db.productEvent.findMany({
        where: { productId: { in: productIds }, type: 'view', createdAt: { gte: from, lte: to } },
        select: { productId: true, createdAt: true },
      });
      for (const v of viewEvents) {
        const bucket = dayIndex.get(v.createdAt.toISOString().slice(0, 10));
        if (bucket) bucket.views += 1;
      }
      viewsTotal = viewEvents.length;
    }

    // Per-product performance (units, revenue, views).
    const perProduct = new Map<string, { units: number; revenue: number }>();
    for (const o of orders) {
      for (const item of o.items) {
        const agg = perProduct.get(item.productId) ?? { units: 0, revenue: 0 };
        agg.units += item.quantity;
        agg.revenue += item.unitPriceCents * item.quantity / 100;
        perProduct.set(item.productId, agg);
      }
    }
    const viewsPerProduct = new Map<string, number>();
    if (productIds.length > 0) {
      const ve = await db.productEvent.groupBy({
        by: ['productId'],
        where: { productId: { in: productIds }, type: 'view', createdAt: { gte: from, lte: to } },
        _count: { _all: true },
      });
      for (const v of ve) viewsPerProduct.set(v.productId, v._count._all);
    }
    const topProducts = [...perProduct.entries()]
      .map(([productId, agg]) => ({
        productId,
        name: productName.get(productId) ?? 'Removed product',
        units: agg.units,
        revenue: agg.revenue,
        views: viewsPerProduct.get(productId) ?? 0,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8);

    // Category split from real sold items.
    const catIds = [...new Set(myProducts.map((p) => p.categoryId).filter(Boolean))] as string[];
    const categories = catIds.length > 0 ? await db.category.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true } }) : [];
    const catName = new Map(categories.map((c) => [c.id, c.name]));
    const catRevenue = new Map<string, number>();
    for (const o of orders) {
      for (const item of o.items) {
        const prod = myProducts.find((p) => p.id === item.productId);
        const key = prod?.categoryId ? catName.get(prod.categoryId) ?? 'Uncategorised' : 'Uncategorised';
        catRevenue.set(key, (catRevenue.get(key) ?? 0) + (item.unitPriceCents * item.quantity) / 100);
      }
    }

    const recentOrders = await db.order.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: { items: { where: { storeId: store.id }, select: { id: true, productId: true, name: true, variantLabel: true, quantity: true, unitPriceCents: true } } },
    });

    const lowStock = productIds.length > 0
      ? await db.product.count({ where: { storeId: store.id, status: 'approved', OR: [{ AND: [{ stock: { lte: 5 } }, { stock: { gt: 0 } }] }, { stock: 0 }] } })
      : 0;
    const outOfStock = productIds.length > 0
      ? await db.product.count({ where: { storeId: store.id, status: 'approved', stock: 0 } })
      : 0;

    const conversionPct = viewsTotal > 0 ? Math.min(100, (units / viewsTotal) * 100) : null;

    return Response.json({
      totals: {
        revenueCents,
        orders: orders.length,
        units,
        avgOrderValueCents: orders.length > 0 ? Math.round(revenueCents / orders.length) : 0,
        views: viewsTotal,
        addToLists: listEventsTotal,
        conversionPct: conversionPct === null ? null : Number(conversionPct.toFixed(1)),
        products: myProducts.length,
        lowStock,
        outOfStock,
      },
      daily,
      categories: [...catRevenue.entries()].map(([category, revenue]) => ({ category, revenue })).sort((a, b) => b.revenue - a.revenue),
      topProducts,
      recentOrders,
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('seller analytics error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load analytics.' }, { status: 500 });
  }
}
