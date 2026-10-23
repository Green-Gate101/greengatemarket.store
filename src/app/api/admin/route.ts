import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireRole, authErrorResponse } from '@/lib/auth';
import { platformFeePercent, ggpayEngineMode } from '@/lib/ggpay';
import { audit } from '@/lib/audit';
import { bootstrap } from '@/lib/bootstrap';
import { SALE_STATUSES, formatMoney } from '@/lib/types';
import { notify } from '@/lib/notify';

export const dynamic = 'force-dynamic';

/** Admin console overview: users, stores, products, orders, categories, audit trail. */
export async function GET() {
  try {
    await bootstrap();
    await requireRole('ADMIN');

    const [userTotal, sellerCount, bannedCount, recentUsers, stores, productAgg, orderList, categories, auditLogs] = await Promise.all([
      db.user.count(),
      db.user.count({ where: { role: 'SELLER' } }),
      db.user.count({ where: { banned: true } }),
      db.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { id: true, email: true, name: true, role: true, banned: true, phone: true, createdAt: true },
      }),
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
      db.order.aggregate({ where: { status: { in: SALE_STATUSES } }, _count: { _all: true }, _sum: { totalCents: true, subtotalCents: true, shippingCents: true } }),
    ]);

    // Store applications awaiting review + status breakdowns + 14-day daily
    // series — all real rows, no sampling, computed from the database.
    const [applications, sinceData, orderStatusAgg, paymentStatusAgg, userRoleAgg, storeStatusAgg] = await Promise.all([
      db.store.findMany({
        where: { status: 'pending' },
        orderBy: { applicationAt: 'asc' },
        take: 100,
        include: { user: { select: { id: true, email: true, name: true, createdAt: true } } },
      }),
      (async () => {
        const since = new Date();
        since.setUTCHours(0, 0, 0, 0);
        since.setUTCDate(since.getUTCDate() - 13);
        const [orders, users, products, stores] = await Promise.all([
          db.order.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, status: true, shippingCents: true, subtotalCents: true, totalCents: true } }),
          db.user.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, role: true } }),
          db.product.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
          db.store.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, status: true } }),
        ]);
        return { since, orders, users, products, stores };
      })(),
      db.order.groupBy({ by: ['status'], _count: { _all: true } }),
      db.order.groupBy({ by: ['paymentStatus'], _count: { _all: true } }),
      db.user.groupBy({ by: ['role'], _count: { _all: true } }),
      db.store.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    // Insights — real usage telemetry for the admin console (30-day window,
    // every figure computed from actual rows, no sampling, no placeholders).
    const since30 = new Date();
    since30.setUTCHours(0, 0, 0, 0);
    since30.setUTCDate(since30.getUTCDate() - 29);
    const day30 = since30.toISOString().slice(0, 10);
    const [topSearches, emptySearches, eventUsage, apiUsageRows, searchTotal] = await Promise.all([
      db.searchLog.groupBy({ by: ['term'], where: { createdAt: { gte: since30 } }, _count: { _all: true }, orderBy: { _count: { term: 'desc' } }, take: 10 }),
      db.searchLog.groupBy({ by: ['term'], where: { createdAt: { gte: since30 }, results: 0 }, _count: { _all: true }, orderBy: { _count: { term: 'desc' } }, take: 10 }),
      db.productEvent.groupBy({ by: ['type'], where: { createdAt: { gte: since30 } }, _count: { _all: true } }),
      db.apiUsage.groupBy({ by: ['service'], where: { day: { gte: day30 } }, _sum: { count: true } }),
      db.searchLog.count({ where: { createdAt: { gte: since30 } } }),
    ]);
    const insights = {
      windowDays: 30,
      searchTotal,
      topSearches: topSearches.map((t) => ({ term: t.term, count: t._count._all })),
      emptySearches: emptySearches.map((t) => ({ term: t.term, count: t._count._all })),
      featureUsage: eventUsage.map((e) => ({ type: e.type, count: e._count._all })),
      apiUsage: apiUsageRows.map((a) => ({ service: a.service, calls: a._sum.count ?? 0 })),
      // Real configured-state from the actual server environment — the client
      // can never guess this. geocode is always on (free public endpoints).
      services: {
        resend: Boolean(process.env.RESEND_API_KEY),
        courier_guy: Boolean(process.env.COURIER_GUY_ACCOUNT_ID && process.env.COURIER_GUY_API_KEY),
        geocode: true,
        algolia: Boolean(process.env.ALGOLIA_APP_ID && process.env.ALGOLIA_ADMIN_KEY),
      } as Record<string, boolean>,
    };

    const saleStatuses = new Set<string>(SALE_STATUSES);
    const dayKey = (d: Date) => d.toISOString().slice(0, 10);
    const days: string[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(sinceData.since);
      d.setUTCDate(d.getUTCDate() + i);
      days.push(dayKey(d));
    }
    const cells = new Map(days.map((date) => [date, {
      date, orders: 0, revenueCents: 0, sellerEarningsCents: 0, deliveryCents: 0,
      users: 0, sellers: 0, products: 0, stores: 0, applications: 0,
    }]));
    for (const o of sinceData.orders) {
      if (!saleStatuses.has(o.status)) continue;
      const cell = cells.get(dayKey(o.createdAt));
      if (!cell) continue;
      cell.orders += 1;
      cell.revenueCents += o.totalCents;
      cell.sellerEarningsCents += o.subtotalCents;
      cell.deliveryCents += o.shippingCents;
    }
    for (const u of sinceData.users) {
      const cell = cells.get(dayKey(u.createdAt));
      if (!cell) continue;
      cell.users += 1;
      if (u.role === 'SELLER') cell.sellers += 1;
    }
    for (const p of sinceData.products) {
      const cell = cells.get(dayKey(p.createdAt));
      if (cell) cell.products += 1;
    }
    for (const s of sinceData.stores) {
      const cell = cells.get(dayKey(s.createdAt));
      if (!cell) continue;
      cell.stores += 1;
      if (s.status === 'pending') cell.applications += 1;
    }

    const statusMap = new Map(productAgg.map((p) => [p.status, p._count._all]));

    // GGPay in-app payments + seller payouts — real rows, real money, no
    // sampling. Powers the console's payment graphs and payout queue.
    const [paymentByStatus, paymentByProvider, payoutByStatus, recentPayments, recentPayouts] = await Promise.all([
      db.payment.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amountCents: true } }),
      db.payment.groupBy({ by: ['provider'], where: { status: 'paid' }, _count: { _all: true }, _sum: { amountCents: true } }),
      db.payout.groupBy({ by: ['status'], _count: { _all: true }, _sum: { netCents: true } }),
      db.payment.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { order: { select: { number: true, buyerName: true } } },
      }),
      db.payout.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { order: { select: { number: true } }, store: { select: { name: true } } },
      }),
    ]);
    const payStatusOf = (s: string) => paymentByStatus.find((p) => p.status === s);
    const payoutStatusOf = (s: string) => payoutByStatus.find((p) => p.status === s);
    const paidCount = payStatusOf('paid')?._count._all ?? 0;
    const failedCount = payStatusOf('failed')?._count._all ?? 0;

    return Response.json({
      users: {
        total: userTotal,
        sellers: sellerCount,
        buyers: userTotal - sellerCount,
        banned: bannedCount,
        recent: recentUsers.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          banned: u.banned,
          phone: u.phone,
          createdAt: u.createdAt.toISOString(),
        })),
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
        sellerGrossCents: salesAgg._sum.subtotalCents ?? 0,
        deliveryCents: salesAgg._sum.shippingCents ?? 0,
        recent: orderList,
      },
      categories,
      statuses: {
        orders: Object.fromEntries(orderStatusAgg.map((r) => [r.status, r._count._all])),
        payments: Object.fromEntries(paymentStatusAgg.map((r) => [r.paymentStatus, r._count._all])),
        users: Object.fromEntries(userRoleAgg.map((r) => [r.role, r._count._all])),
        stores: Object.fromEntries(storeStatusAgg.map((r) => [r.status, r._count._all])),
        products: Object.fromEntries(productAgg.map((p) => [p.status, p._count._all])),
      },
      daily: days.map((k) => cells.get(k)!),
      payments: {
        paid: paidCount,
        failed: failedCount,
        successRatePct: paidCount + failedCount > 0 ? Math.round((paidCount * 100) / (paidCount + failedCount)) : null,
        volumeCents: payStatusOf('paid')?._sum.amountCents ?? 0,
        byProvider: paymentByProvider.map((p) => ({ provider: p.provider, count: p._count._all, volumeCents: p._sum.amountCents ?? 0 })),
        recent: recentPayments.map((p) => ({
          id: p.id, reference: p.reference, orderNumber: p.order?.number ?? '', buyerName: p.order?.buyerName ?? '',
          provider: p.provider, method: p.method, status: p.status, amountCents: p.amountCents,
          cardBrand: p.cardBrand, cardLast4: p.cardLast4, failureReason: p.failureReason,
          createdAt: p.createdAt.toISOString(),
        })),
      },
      payouts: {
        pending: { count: payoutStatusOf('pending')?._count._all ?? 0, netCents: payoutStatusOf('pending')?._sum.netCents ?? 0 },
        processing: { count: payoutStatusOf('processing')?._count._all ?? 0, netCents: payoutStatusOf('processing')?._sum.netCents ?? 0 },
        paid: { count: payoutStatusOf('paid')?._count._all ?? 0, netCents: payoutStatusOf('paid')?._sum.netCents ?? 0 },
        feePercent: platformFeePercent(),
      },
      // Payment-engine honesty for the admin: the in-app GGPay card engine is
      // 'test' until a production acquirer credential (GGPAY_ACQUIRER_KEY) is
      // configured — in test mode only published sandbox test cards are
      // decided on and REAL cards are refused, so no buyer can ever "pay"
      // without money actually moving. Seller-owned processors (Yoco / PayFast
      // / Ozow keys each seller connects) are always REAL rails.
      paymentEngine: {
        ggpayMode: ggpayEngineMode(),
        feePercent: platformFeePercent(),
      },
      payoutRows: recentPayouts.map((p) => ({
        id: p.id, reference: p.reference, orderNumber: p.order?.number ?? '', storeName: p.store?.name ?? '',
        netCents: p.netCents, destination: p.destination, status: p.status,
        createdAt: p.createdAt.toISOString(),
      })),
      insights,
      applications: applications.map((s) => ({
        id: s.id, userId: s.userId, slug: s.slug, name: s.name, description: s.description,
        location: s.location, phone: s.phone,
        createdAt: s.createdAt.toISOString(), applicationAt: s.applicationAt?.toISOString() ?? null,
        owner: { id: s.user.id, email: s.user.email, name: s.user.name, memberSince: s.user.createdAt.toISOString() },
        business: {
          businessName: s.businessName, businessType: s.businessType, registrationNumber: s.registrationNumber,
          taxNumber: s.taxNumber, idNumber: s.idNumber, websiteOrSocial: s.websiteOrSocial, ownsBrand: s.ownsBrand,
        },
        address: { streetAddress: s.streetAddress, city: s.city, province: s.province, postalCode: s.postalCode },
        banking: {
          bankName: s.bankName, bankAccountType: s.bankAccountType, bankAccountNumber: s.bankAccountNumber,
          bankBranchCode: s.bankBranchCode, bankAccountHolder: s.bankAccountHolder,
        },
        operations: {
          productCategories: s.productCategories, sourcing: s.sourcing, monthlyVolume: s.monthlyVolume,
          dispatchDays: s.dispatchDays, returnsDays: s.returnsDays,
        },
        declarations: { confirmAge: s.confirmAge, confirmAccuracy: s.confirmAccuracy, confirmTerms: s.confirmTerms },
      })),
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
    const body = (await req.json()) as { action?: string; targetId?: string; value?: string; note?: string };
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
        if (!['active', 'suspended', 'declined'].includes(status)) {
          return Response.json({ error: 'Invalid store status' }, { status: 400 });
        }
        const note = String(body.note ?? '').trim().slice(0, 500) || null;
        const store = await db.store.findUnique({
          where: { id: targetId },
          select: { id: true, userId: true, slug: true, name: true, status: true, user: { select: { email: true, name: true } } },
        });
        if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });
        if (store.status === status) {
          return Response.json({ error: `Store is already ${status}.` }, { status: 409 });
        }
        await db.store.update({ where: { id: targetId }, data: { status } });

        // Application decisions notify the seller (best-effort, never blocks).
        const approving = status === 'active' && store.status === 'pending';
        const declining = status === 'declined';
        if (approving) {
          void notify({
            userId: store.userId,
            type: 'store_approved',
            title: 'Store approved',
            body: `Your store “${store.name}” was approved and is now live on Green Gate. You can start listing products.`,
            link: '/dashboard',
          });
          void (async () => {
            const { sendStoreWelcome } = await import('@/lib/email');
            void sendStoreWelcome({ to: store.user.email, storeName: store.name, ownerName: store.user.name ?? 'Seller' });
          })();
        } else if (declining) {
          void notify({
            userId: store.userId,
            type: 'store_declined',
            title: 'Store application declined',
            body: note
              ? `Your application for “${store.name}” was declined: ${note}`
              : `Your application for “${store.name}” was declined. Contact support if you believe this is a mistake.`,
            link: '/dashboard',
          });
        }

        await audit({
          actorId: session.user.id,
          actorEmail: session.user.email,
          action: approving ? 'store_application_approved' : declining ? 'store_application_declined' : 'store_status_changed',
          target: targetId,
          detail: note ? `${status} · ${store.name} · ${note}` : `${status} · ${store.name}`,
        });
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
      case 'payout_status': {
        // Advance a seller payout: pending → processing → paid. The terminal
        // 'paid' state is irreversible from the console (a real EFT has gone
        // out); refunds are handled as new negative payouts later.
        const status = String(body.value ?? '');
        if (!['processing', 'paid'].includes(status)) {
          return Response.json({ error: 'Invalid payout status' }, { status: 400 });
        }
        const payout = await db.payout.findUnique({ where: { id: targetId } });
        if (!payout) return Response.json({ error: 'Payout not found' }, { status: 404 });
        const allowed: Record<string, string[]> = { pending: ['processing', 'paid'], processing: ['paid'], paid: [] };
        if (!(allowed[payout.status] ?? []).includes(status)) {
          return Response.json({ error: `A ${payout.status} payout cannot move to ${status}.` }, { status: 409 });
        }
        // Atomic transition — the previous status lives in the WHERE so two
        // concurrent admin PATCHes can never both win.
        const moved = await db.payout.updateMany({ where: { id: payout.id, status: payout.status }, data: { status, paidAt: status === 'paid' ? new Date() : null } });
        if (moved.count === 0) {
          return Response.json({ error: `A ${payout.status} payout cannot move to ${status}.` }, { status: 409 });
        }
        if (status === 'paid' && payout.sellerId) {
          void notify({
            userId: payout.sellerId,
            type: 'payout_paid',
            title: 'Payout paid',
            body: `${payout.reference} — ${formatMoney(payout.netCents)} was paid out to ${payout.destination}.`,
            link: '/dashboard',
          });
        }
        await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'payout_status_changed', target: payout.reference, detail: `${payout.status} → ${status}` });
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
      case 'user_ban': {
        // Ban / unban an account. Sellers only — administrators cannot be
        // locked out through the console. Banning also suspends the account's
        // store so listings disappear from the live marketplace immediately.
        const banned = String(body.value ?? '') === 'true';
        const target = await db.user.findUnique({
          where: { id: targetId },
          select: { id: true, email: true, role: true, banned: true },
        });
        if (!target) {
          return Response.json(
            { error: 'Account not found on this server (temporary-storage mode): connect a hosted database for durable data.' },
            { status: 503 },
          );
        }
        if (target.role === 'ADMIN') {
          return Response.json({ error: 'Administrator accounts cannot be banned.' }, { status: 400 });
        }
        if (target.banned === banned) {
          return Response.json({ error: `Account is already ${banned ? 'banned' : 'active'}.` }, { status: 409 });
        }
        await db.$transaction([
          db.user.update({ where: { id: target.id }, data: { banned } }),
          // Ban suspends every store the account owns; unban restores the
          // suspended ones (the suspension came from the ban — an admin can
          // still suspend a store directly via store_status at any time).
          ...(banned
            ? [db.store.updateMany({ where: { userId: target.id, status: { not: 'suspended' } }, data: { status: 'suspended' } })]
            : [db.store.updateMany({ where: { userId: target.id, status: 'suspended' }, data: { status: 'active' } })]),
        ]);
        if (banned) {
          void notify({
            userId: target.id,
            type: 'account_banned',
            title: 'Account suspended',
            body: 'Your Green Gate account has been suspended by the marketplace administration. Contact support if you believe this is a mistake.',
            link: '/',
          });
        }
        await audit({
          actorId: session.user.id,
          actorEmail: session.user.email,
          action: banned ? 'user_banned' : 'user_unbanned',
          target: target.email,
          detail: banned ? 'account banned; store suspended' : 'account unbanned; suspended stores restored',
        });
        return Response.json({ ok: true, banned });
      }
      case 'delete_order': {
        // Permanently remove a junk/test order with its items and event trail.
        // Real customer orders should be kept — this is for admin hygiene only.
        const order = await db.order.findUnique({ where: { id: targetId }, select: { id: true, number: true, buyerEmail: true } });
        if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
        await db.order.delete({ where: { id: order.id } }); // cascades OrderItem + OrderEvent
        await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'order_deleted', target: order.number, detail: order.buyerEmail });
        return Response.json({ ok: true });
      }
      case 'delete_user': {
        // Permanently delete an account and EVERY trace of it (stores,
        // products, orders, events, tokens, audit entries). Guards: an admin
        // can never delete themselves or another admin. Runs in one
        // transaction so a partial delete can never leave orphaned rows.
        if (targetId === session.user.id) {
          return Response.json({ error: 'You cannot delete your own account.' }, { status: 400 });
        }
        const target = await db.user.findUnique({ where: { id: targetId }, select: { id: true, email: true, role: true } });
        if (!target) return Response.json({ error: 'Account not found' }, { status: 404 });
        if (target.role === 'ADMIN') {
          return Response.json({ error: 'Administrator accounts cannot be deleted.' }, { status: 400 });
        }
        // Financial-records guard: paid orders and payouts are money trails
        // that must never be destroyed. Suspend (ban) the account instead —
        // that removes their access while keeping every financial record.
        const targetStoreIds = (await db.store.findMany({ where: { userId: target.id }, select: { id: true } })).map((s) => s.id);
        const paidOrders = await db.order.count({
          where: {
            paymentStatus: 'paid',
            OR: [{ buyerId: target.id }, ...(targetStoreIds.length > 0 ? [{ storeId: { in: targetStoreIds } }] : [])],
          },
        });
        if (paidOrders > 0) {
          return Response.json({ error: `This account has ${paidOrders} paid order(s) — financial records cannot be deleted. Suspend the account instead (it loses all access while the money trail is preserved).` }, { status: 409 });
        }
        const storeIds = (await db.store.findMany({ where: { userId: target.id }, select: { id: true } })).map((s) => s.id);
        const productIds = storeIds.length > 0
          ? (await db.product.findMany({ where: { storeId: { in: storeIds } }, select: { id: true } })).map((p) => p.id)
          : [];
        await db.$transaction([
          // Orders referencing this account (as buyer or seller) go first —
          // their items and events cascade with them.
          db.order.deleteMany({ where: { OR: [{ buyerId: target.id }, { storeId: { in: storeIds } }] } }),
          // Audit entries by or about the account and its stores/products.
          db.auditLog.deleteMany({
            where: { OR: [{ actorId: target.id }, { target: { in: [...storeIds, ...productIds] } }] },
          }),
          // Behaviour events and tokens tied to the account.
          db.productEvent.deleteMany({ where: { userId: target.id } }),
          db.authToken.deleteMany({ where: { identifier: target.email } }),
          db.recommendationState.deleteMany({ where: { scope: `user:${target.id}` } }),
          // Finally the account itself — schema cascades Account, stores →
          // products → images/variants/events/reviews, cart, wishlist,
          // notifications and addresses.
          db.user.delete({ where: { id: target.id } }),
        ]);
        await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'user_deleted', target: target.email, detail: `${storeIds.length} store(s) removed` });
        return Response.json({ ok: true });
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
