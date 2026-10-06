import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireRole, authErrorResponse } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { bootstrap } from '@/lib/bootstrap';
import { SALE_STATUSES } from '@/lib/types';
import { notify } from '@/lib/notify';

export const dynamic = 'force-dynamic';

/** Admin console overview: users, stores, products, orders, categories, audit trail. */
export async function GET() {
  try {
    await bootstrap();
    await requireRole('ADMIN');

    const [userTotal, sellerCount, recentUsers, stores, productAgg, orderList, categories, auditLogs] = await Promise.all([
      db.user.count(),
      db.user.count({ where: { role: 'SELLER' } }),
      db.user.findMany({ orderBy: { createdAt: 'desc' }, take: 10, select: { email: true, name: true, role: true, createdAt: true } }),
      db.store.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, slug: true, name: true, status: true, createdAt: true, user: { select: { email: true } }, _count: { select: { products: true } } },
      }),
      db.product.groupBy({ by: ['status'], _count: { _all: true } }),
      db.order.findMany({ orderBy: { createdAt: 'desc' }, take: 15, include: { items: true, store: { select: { name: true, slug: true } } } }),
      db.category.findMany({ where: { parentId: null }, orderBy: { sortOrder: 'asc' }, select: { id: true, slug: true, name: true, parentId: true } }),
      db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 30, include: { actor: { select: { email: true } } } }),
    ]);

    const [orderTotal, pendingPayment, salesAgg] = await Promise.all([
      db.order.count(),
      db.order.count({ where: { status: 'pending_payment' } }),
      db.order.aggregate({ where: { status: { in: SALE_STATUSES } }, _count: { _all: true }, _sum: { totalCents: true } }),
    ]);

    const statusMap = new Map(productAgg.map((p) => [p.status, p._count._all]));

    return Response.json({
      users: {
        total: userTotal,
        sellers: sellerCount,
        buyers: userTotal - sellerCount,
        recent: recentUsers,
      },
      stores: stores.map((s) => ({
        id: s.id, slug: s.slug, name: s.name, status: s.status,
        email: s.user.email, productCount: s._count.products, createdAt: s.createdAt.toISOString(),
      })),
      products: {
        total: productAgg.reduce((s, p) => s + p._count._all, 0),
        pending: statusMap.get('pending_review') ?? 0,
        approved: statusMap.get('approved') ?? 0,
        disabled: (statusMap.get('disabled') ?? 0) + (statusMap.get('archived') ?? 0),
      },
      orders: {
        total: orderTotal,
        pendingPayment,
        sales: salesAgg._count._all,
        revenueCents: salesAgg._sum.totalCents ?? 0,
        recent: orderList,
      },
      categories,
      auditLogs: auditLogs.map((a) => ({
        id: a.id, action: a.action, target: a.target, detail: a.detail,
        actorEmail: a.actorEmail ?? a.actor?.email ?? null, createdAt: a.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('admin GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load the admin overview.' }, { status: 500 });
  }
}

/** Administrative actions — every one authenticated, role-checked and audited. */
export async function POST(req: NextRequest) {
  try {
    const session = await requireRole('ADMIN');
    const body = (await req.json()) as { action?: string; targetId?: string; value?: string };
    const action = String(body.action ?? '');
    const targetId = String(body.targetId ?? '');

    switch (action) {
      case 'moderate_product': {
        const status = String(body.value ?? '');
        if (!['approved', 'disabled', 'rejected'].includes(status)) {
          return Response.json({ error: 'Invalid moderation status' }, { status: 400 });
        }
        const product = await db.product.findUnique({ where: { id: targetId } });
        if (!product) return Response.json({ error: 'Product not found' }, { status: 404 });
        await db.product.update({ where: { id: targetId }, data: { status, moderationNote: status !== 'approved' ? 'Disabled by marketplace administration' : null } });
        if (status !== 'approved') {
          const { removeProduct } = await import('@/lib/algolia');
          await removeProduct(targetId);
        }
        await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'product_moderated', target: targetId, detail: status });
        return Response.json({ ok: true });
      }
      case 'store_status': {
        const status = String(body.value ?? '');
        if (!['active', 'suspended'].includes(status)) {
          return Response.json({ error: 'Invalid store status' }, { status: 400 });
        }
        await db.store.update({ where: { id: targetId }, data: { status } });
        await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'store_status_changed', target: targetId, detail: status });
        return Response.json({ ok: true });
      }
      case 'confirm_payment': {
        const order = await db.order.findUnique({ where: { id: targetId } });
        if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
        if (order.paymentStatus !== 'awaiting_payment') {
          return Response.json({ error: 'Payment already processed.' }, { status: 409 });
        }
        await db.$transaction([
          db.order.update({ where: { id: order.id }, data: { paymentStatus: 'paid', status: order.status === 'pending_payment' ? 'confirmed' : order.status, paymentRef: `ADMIN-${order.number}` } }),
          db.orderEvent.create({ data: { orderId: order.id, status: 'confirmed', note: 'Payment receipt confirmed by marketplace administration', actorId: session.user.id } }),
        ]);
        // Buyer notification: in-app + email (best-effort, never blocks).
        if (order.buyerId) {
          void notify({
            userId: order.buyerId,
            type: 'payment_confirmed',
            title: 'Payment confirmed',
            body: `Payment for order ${order.number} was received. Your order is being prepared.`,
            link: '/orders',
          });
        }
        void (async () => {
          const { sendOrderStatusEmail } = await import('@/lib/email');
          void sendOrderStatusEmail({ to: order.buyerEmail, orderNumber: order.number, statusLabel: 'Payment received — order confirmed' });
        })();
        await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'payment_confirmed_admin', target: order.number });
        return Response.json({ ok: true });
      }
      case 'create_category': {
        const name = String(body.value ?? '').trim();
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (name.length < 2 || !slug) return Response.json({ error: 'Enter a category name' }, { status: 400 });
        const exists = await db.category.findUnique({ where: { slug } });
        if (exists) return Response.json({ error: 'That category already exists' }, { status: 409 });
        const count = await db.category.count({ where: { parentId: null } });
        await db.category.create({ data: { slug, name, sortOrder: count + 1 } });
        await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'category_created', target: slug, detail: name });
        return Response.json({ ok: true }, { status: 201 });
      }
      default:
        return Response.json({ error: 'Unknown action.' }, { status: 400 });
    }
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('admin POST error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Action failed.' }, { status: 500 });
  }
}
