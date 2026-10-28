import { NextRequest } from 'next/server';
import { db, IS_POSTGRES } from '@/lib/db';
import { requireRole, authErrorResponse } from '@/lib/auth';
import { platformFeePercent, ggpayEngineMode } from '@/lib/ggpay';
import { audit } from '@/lib/audit';
import { bootstrap } from '@/lib/bootstrap';
import { SALE_STATUSES, formatMoney } from '@/lib/types';
import { notify } from '@/lib/notify';
import { payoutOnHold, PAYOUT_HOLD_ORDER_STATUSES } from '@/lib/payments';
import { rateLimitShared, tooManyRequests } from '@/lib/rate-limit';
import { storeAccess, trialStartData, subscriptionPaymentsStatus, planPriceCents, TRIAL_DAYS } from '@/lib/subscription';
import { cleanMessageText } from '@/lib/messages';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';
import { APPLICATION_SELECT, applicationView } from '@/lib/seller-application';
import { discountConditions, discountLabel, releaseDiscountUse } from '@/lib/discounts';
import { restockOrderItems } from '@/lib/inventory';
import { walletBalances, accountBalanceCents, recentLedgerRows, recordPair } from '@/lib/ledger';
import { releaseEscrowForOrder } from '@/lib/escrow';

export const dynamic = 'force-dynamic';

/**
 * Same-site CSRF guard (additive): the admin API's cookie is SameSite=Lax, but
 * greengatemarket.store and admin.greengatemarket.store are the SAME site — a
 * script on any storefront origin would still get the admin's cookie attached
 * to a forged request. Browsers mark their own same-origin calls with
 * `Sec-Fetch-Site: same-origin` and a matching Origin; anything that declares
 * itself cross-site is refused. Non-browser callers (the console's server-side
 * proxy, curl, tests) send neither header and are unaffected. Mirrors
 * admin-console/src/app/api/console/same-origin.ts.
 */
function isCrossSiteBrowserRequest(req: NextRequest): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.get('origin');
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  const hosts = [req.headers.get('x-forwarded-host'), req.headers.get('host')]
    .flatMap((h) => (h ? h.split(',').map((x) => x.trim()) : []));
  return !hosts.includes(originHost);
}

/** Admin console overview: users, stores, products, orders, categories, audit trail. */
export async function GET(req: NextRequest) {
  try {
    if (isCrossSiteBrowserRequest(req)) return Response.json({ error: 'Cross-site request refused.' }, { status: 403 });
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
        select: { id: true, slug: true, name: true, status: true, createdAt: true, verifiedAt: true, user: { select: { email: true } }, _count: { select: { products: true } } },
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
      // Only the application's columns — the whole row used to come back,
      // logo and banner images included, for every waiting application.
      db.store.findMany({
        where: { status: 'pending' },
        orderBy: { applicationAt: 'asc' },
        take: 100,
        select: APPLICATION_SELECT,
      }),
      (async () => {
        const since = new Date();
        since.setUTCHours(0, 0, 0, 0);
        since.setUTCDate(since.getUTCDate() - 13);
        // Postgres (production): the database sums each day — the same
        // figures without pulling every row of 14 days into memory, which
        // would exhaust the function at marketplace scale.
        if (IS_POSTGRES) {
          try {
            const [o, u, p, s] = await Promise.all([
              db.$queryRaw<{ day: string; orders: number; revenue: bigint; earnings: bigint; delivery: bigint }[]>`
                SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day, count(*)::int AS orders,
                       coalesce(sum("totalCents"), 0)::bigint AS revenue, coalesce(sum("subtotalCents"), 0)::bigint AS earnings,
                       coalesce(sum("shippingCents"), 0)::bigint AS delivery
                FROM "Order" WHERE "createdAt" >= ${since} AND "status" = ANY(${SALE_STATUSES as string[]}) GROUP BY 1`,
              db.$queryRaw<{ day: string; users: number; sellers: number }[]>`
                SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day, count(*)::int AS users,
                       (count(*) FILTER (WHERE "role" = 'SELLER'))::int AS sellers
                FROM "User" WHERE "createdAt" >= ${since} GROUP BY 1`,
              db.$queryRaw<{ day: string; products: number }[]>`
                SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day, count(*)::int AS products
                FROM "Product" WHERE "createdAt" >= ${since} GROUP BY 1`,
              db.$queryRaw<{ day: string; stores: number; applications: number }[]>`
                SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day, count(*)::int AS stores,
                       (count(*) FILTER (WHERE "status" = 'pending'))::int AS applications
                FROM "Store" WHERE "createdAt" >= ${since} GROUP BY 1`,
            ]);
            return { since, aggregated: { orders: o, users: u, products: p, stores: s }, orders: [], users: [], products: [], stores: [] };
          } catch (e) {
            // Never break the dashboard: fall back to the row-based count.
            console.error('admin daily aggregate failed, using row scan:', e instanceof Error ? e.message : e);
          }
        }
        const [orders, users, products, stores] = await Promise.all([
          db.order.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, status: true, shippingCents: true, subtotalCents: true, totalCents: true } }),
          db.user.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, role: true } }),
          db.product.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
          db.store.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, status: true } }),
        ]);
        return { since, aggregated: null, orders, users, products, stores };
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
        remove_bg: Boolean(process.env.REMOVE_BG_API_KEY),
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

    if (sinceData.aggregated) {
      for (const r of sinceData.aggregated.orders) {
        const cell = cells.get(r.day);
        if (!cell) continue;
        cell.orders += Number(r.orders);
        cell.revenueCents += Number(r.revenue);
        cell.sellerEarningsCents += Number(r.earnings);
        cell.deliveryCents += Number(r.delivery);
      }
      for (const r of sinceData.aggregated.users) {
        const cell = cells.get(r.day);
        if (cell) { cell.users += Number(r.users); cell.sellers += Number(r.sellers); }
      }
      for (const r of sinceData.aggregated.products) {
        const cell = cells.get(r.day);
        if (cell) cell.products += Number(r.products);
      }
      for (const r of sinceData.aggregated.stores) {
        const cell = cells.get(r.day);
        if (cell) { cell.stores += Number(r.stores); cell.applications += Number(r.applications); }
      }
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
        include: { order: { select: { number: true, status: true } }, store: { select: { name: true } } },
      }),
    ]);
    // Unpaid payouts whose order was cancelled/refunded/returned — on hold
    // (never to be paid), so they are not money the marketplace owes.
    const heldPayouts = await db.payout.aggregate({
      where: { status: { in: ['pending', 'processing'] }, order: { status: { in: PAYOUT_HOLD_ORDER_STATUSES } } },
      _count: { _all: true },
      _sum: { netCents: true },
    });
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
        email: s.user.email, productCount: s._count.products, createdAt: s.createdAt.toISOString(), verified: Boolean(s.verifiedAt),
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
        held: { count: heldPayouts._count._all, netCents: heldPayouts._sum.netCents ?? 0 },
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
        orderStatus: p.order?.status ?? null, held: p.status !== 'paid' && (payoutOnHold(p.order?.status) || !p.releasedAt),
        releasedAt: p.releasedAt?.toISOString() ?? null,
        createdAt: p.createdAt.toISOString(),
      })),
      // Escrow wallet (additive): platform balances, courier budget and the
      // ledger tail — the admin Finance view reads these directly.
      finance: {
        balances: await walletBalances(),
        shippingBalanceCents: await accountBalanceCents(db, 'platform_shipping', null),
        escrowHeldCents: (await db.ledgerEntry.aggregate({ where: { state: 'held', account: { kind: 'seller_escrow' } }, _sum: { amountCents: true } }))._sum.amountCents ?? 0,
        unreleasedPayouts: await db.payout.count({ where: { releasedAt: null, status: { not: 'paid' } } }),
        recent: await recentLedgerRows(40),
      },
      insights,
      applications: applications.map(applicationView),
      auditLogs: auditLogs.map((a) => ({
        id: a.id, action: a.action, target: a.target, detail: a.detail,
        actorEmail: a.actorEmail ?? a.actor?.email ?? null, createdAt: a.createdAt.toISOString(),
      })),
      ...(await subscriptionsAndMessages()),
      discountCodes: await discountCodesForAdmin(),
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('admin GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load the admin overview.' }, { status: 500 });
  }
}

/**
 * Seller subscriptions (who is on trial, who paid, who did not, free access)
 * and the admin ↔ seller message threads, for the admin console.
 */
/** Every store's discount codes (newest first) — the console can switch any off. */
async function discountCodesForAdmin() {
  const codes = await db.discountCode.findMany({
    orderBy: { createdAt: 'desc' },
    take: 300,
    select: {
      id: true, code: true, percentOff: true, amountOffCents: true, minSubtotalCents: true, firstOrderOnly: true,
      maxUses: true, usedCount: true, expiresAt: true, active: true, disabledByAdmin: true, createdAt: true,
      store: { select: { id: true, name: true } },
    },
  });
  return codes.map((c) => ({
    id: c.id, code: c.code, storeId: c.store.id, storeName: c.store.name, label: discountLabel(c), conditions: discountConditions(c),
    usedCount: c.usedCount, maxUses: c.maxUses, active: c.active, disabledByAdmin: c.disabledByAdmin,
    expiresAt: c.expiresAt?.toISOString() ?? null, createdAt: c.createdAt.toISOString(),
  }));
}

async function subscriptionsAndMessages() {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const days30 = new Date(now.getTime() - 30 * 86_400_000);
  const [stores, payments, perStore, month, last30, allTime, messages, paymentsStatus] = await Promise.all([
    db.store.findMany({
      orderBy: { createdAt: 'desc' },
      take: 1000,
      select: {
        id: true, name: true, slug: true, status: true, createdAt: true,
        billingExempt: true, billingExemptNote: true, trialEndsAt: true, paidUntil: true, accessUntil: true, subscriptionPlan: true,
        user: { select: { email: true, name: true, role: true } },
      },
    }),
    db.subscriptionPayment.findMany({
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: { id: true, reference: true, plan: true, amountCents: true, status: true, createdAt: true, paidAt: true, periodStart: true, periodEnd: true, store: { select: { id: true, name: true } } },
    }),
    db.subscriptionPayment.groupBy({ by: ['storeId'], where: { status: 'paid' }, _sum: { amountCents: true }, _count: { _all: true }, _max: { paidAt: true } }),
    db.subscriptionPayment.aggregate({ where: { status: 'paid', paidAt: { gte: monthStart } }, _sum: { amountCents: true }, _count: { _all: true } }),
    db.subscriptionPayment.aggregate({ where: { status: 'paid', paidAt: { gte: days30 } }, _sum: { amountCents: true }, _count: { _all: true } }),
    db.subscriptionPayment.aggregate({ where: { status: 'paid' }, _sum: { amountCents: true }, _count: { _all: true } }),
    db.sellerMessage.findMany({
      orderBy: { createdAt: 'desc' },
      take: 1000,
      select: { id: true, storeId: true, fromAdmin: true, body: true, createdAt: true, readAt: true },
    }),
    subscriptionPaymentsStatus().catch(() => ({ ok: false, detail: 'could not be checked' })),
  ]);
  const paidBy = new Map(perStore.map((p) => [p.storeId, p]));
  const billingStores = stores.map((s) => {
    const access = storeAccess(s, now);
    const paid = paidBy.get(s.id);
    return {
      id: s.id, name: s.name, slug: s.slug, status: s.status, createdAt: s.createdAt.toISOString(),
      ownerEmail: s.user.email, ownerName: s.user.name, adminOwned: s.user.role === 'ADMIN',
      state: access.state, accessUntil: access.accessUntil, trialEndsAt: access.trialEndsAt, paidUntil: access.paidUntil,
      plan: access.plan, daysLeft: access.daysLeft, billingExempt: s.billingExempt, billingExemptNote: s.billingExemptNote,
      totalPaidCents: paid?._sum.amountCents ?? 0, paymentsCount: paid?._count._all ?? 0, lastPaidAt: paid?._max.paidAt?.toISOString() ?? null,
    };
  });
  const count = (state: string) => billingStores.filter((b) => b.state === state).length;
  const storeName = new Map(stores.map((s) => [s.id, s.name]));
  const threads = new Map<string, { storeId: string; storeName: string; unread: number; lastAt: string; messages: { id: string; fromAdmin: boolean; body: string; createdAt: string; readAt: string | null }[] }>();
  for (const m of messages) {
    let t = threads.get(m.storeId);
    if (!t) {
      t = { storeId: m.storeId, storeName: storeName.get(m.storeId) ?? 'Store', unread: 0, lastAt: m.createdAt.toISOString(), messages: [] };
      threads.set(m.storeId, t);
    }
    if (!m.fromAdmin && !m.readAt) t.unread++;
    if (t.messages.length < 100) t.messages.push({ id: m.id, fromAdmin: m.fromAdmin, body: m.body, createdAt: m.createdAt.toISOString(), readAt: m.readAt?.toISOString() ?? null });
  }
  return {
    subscriptions: {
      summary: {
        paid: count('paid'), trial: count('trial'), expired: count('expired'), free: count('free'), notActive: count('not_active'),
        revenueThisMonthCents: month._sum.amountCents ?? 0, paymentsThisMonth: month._count._all,
        revenueLast30Cents: last30._sum.amountCents ?? 0, paymentsLast30: last30._count._all,
        revenueAllTimeCents: allTime._sum.amountCents ?? 0, paymentsAllTime: allTime._count._all,
        paymentsOn: paymentsStatus.ok, paymentsDetail: paymentsStatus.detail,
        priceMonthlyCents: planPriceCents('monthly'), priceYearlyCents: planPriceCents('yearly'), trialDays: TRIAL_DAYS,
      },
      stores: billingStores,
      payments: payments.map((p) => ({
        id: p.id, reference: p.reference, plan: p.plan, amountCents: p.amountCents, status: p.status,
        storeId: p.store.id, storeName: p.store.name, createdAt: p.createdAt.toISOString(),
        paidAt: p.paidAt?.toISOString() ?? null, periodStart: p.periodStart?.toISOString() ?? null, periodEnd: p.periodEnd?.toISOString() ?? null,
      })),
    },
    messageThreads: [...threads.values()].map((t) => ({ ...t, messages: t.messages.reverse() })),
  };
}

/** Administrative actions — every one authenticated, role-checked and audited. */
export async function POST(req: NextRequest) {
  try {
    if (isCrossSiteBrowserRequest(req)) return Response.json({ error: 'Cross-site request refused.' }, { status: 403 });
    const session = await requireRole('ADMIN');
    // Burst guard (additive): every action is already authenticated + audited;
    // this caps runaway clients (or a stolen admin session) at 120 actions/min.
    const rl = await rateLimitShared(`admin:${session.user.id}`, 120, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const body = (await readJsonObject(req)) as { action?: string; targetId?: string; value?: string; note?: string; message?: string } | null;
    if (!body) return invalidJsonBody();
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
          select: { id: true, userId: true, slug: true, name: true, status: true, trialEndsAt: true, accessUntil: true, billingExempt: true, user: { select: { email: true, name: true, role: true } } },
        });
        if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });
        if (store.status === status) {
          return Response.json({ error: `Store is already ${status}.` }, { status: 409 });
        }
        // Going live for the first time starts the one-time 30-day free trial;
        // a store owned by the administrator is always free.
        const startsTrial = status === 'active' && !store.trialEndsAt && !store.accessUntil && !store.billingExempt;
        await db.store.update({
          where: { id: targetId },
          data: {
            status,
            ...(startsTrial ? trialStartData() : {}),
            ...(status === 'active' && store.user.role === 'ADMIN' ? { billingExempt: true, billingExemptNote: 'Administrator account' } : {}),
          },
        });

        // Application decisions notify the seller (best-effort, never blocks).
        const approving = status === 'active' && store.status === 'pending';
        const declining = status === 'declined';
        if (approving) {
          void notify({
            userId: store.userId,
            type: 'store_approved',
            title: 'Store approved',
            body: startsTrial && store.user.role !== 'ADMIN'
              ? `Your store “${store.name}” was approved and is now live on Green Gate. Your 30-day free trial has started — you can start listing products.`
              : `Your store “${store.name}” was approved and is now live on Green Gate. You can start listing products.`,
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
        // Atomic claim (additive): the guarded updateMany makes concurrent
        // confirms mutually exclusive — exactly one wins, the loser gets the
        // same 409 the pre-check produced. No TOCTOU window.
        const claimed = await db.$transaction(async (tx) => {
          const claim = await tx.order.updateMany({
            // A cancelled/refunded order can never be confirmed as paid.
            where: { id: order.id, paymentStatus: 'awaiting_payment', status: { notIn: ['cancelled', 'refunded'] } },
            data: { paymentStatus: 'paid', status: order.status === 'pending_payment' ? 'confirmed' : order.status, paymentRef: `ADMIN-${order.number}` },
          });
          if (claim.count === 0) return null;
          await tx.orderEvent.create({ data: { orderId: order.id, status: 'confirmed', note: 'Payment receipt confirmed by marketplace administration', actorId: session.user.id } });
          return true;
        });
        if (claimed === null) return Response.json({ error: 'Payment already processed.' }, { status: 409 });
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
        const payout = await db.payout.findUnique({ where: { id: targetId }, include: { order: { select: { number: true, status: true } } } });
        if (!payout) return Response.json({ error: 'Payout not found' }, { status: 404 });
        if (payoutOnHold(payout.order?.status)) {
          return Response.json({ error: `Order ${payout.order?.number ?? ''} was ${payout.order?.status} — this payout is on hold. Refund the buyer; do not pay the seller.` }, { status: 409 });
        }
        // Escrow guard (additive): sellers are never paid for products that
        // never shipped — release from escrow first (Finance view button).
        if (!payout.releasedAt) {
          return Response.json({ error: 'This payout is still in escrow — release it first (the courier must confirm collection, or use Release in the Finance view).' }, { status: 409 });
        }
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
        // Escrow ledger (additive): the EFT out transfers the seller's
        // released earnings from escrow to "paid out" (Finance view).
        if (status === 'paid') {
          await db.$transaction(async (tx) => {
            await recordPair(tx, {
              amountCents: payout.netCents, state: 'settled', refType: 'payout', refId: payout.id,
              from: { kind: 'seller_escrow', refId: payout.storeId, label: 'Store escrow' },
              to: { kind: 'seller_paid', refId: payout.storeId, label: 'Paid to seller' },
              memo: `payout ${payout.reference} paid to ${payout.destination}`,
            });
          }).catch(() => undefined);
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
        if (name.length < 2 || name.length > 60 || !slug) return Response.json({ error: 'Enter a category name (2–60 characters)' }, { status: 400 });
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
        // Financial-records guard (additive): a PAID order is a money trail —
        // its Payment and Payout rows cascade with it, so exactly like
        // delete_user below, deletion is refused and suspension/suggested
        // flows keep the records instead.
        const order = await db.order.findUnique({ where: { id: targetId }, select: { id: true, number: true, buyerEmail: true, paymentStatus: true } });
        if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
        // Refunded orders and any recorded Payment row are money trails too.
        const paymentRows = await db.payment.count({ where: { orderId: order.id } });
        if (order.paymentStatus === 'paid' || order.paymentStatus === 'refunded' || paymentRows > 0) {
          return Response.json({ error: 'This order has payment records — financial records cannot be deleted. Refund or suspend instead (the money trail is preserved).' }, { status: 409 });
        }
        await db.$transaction(async (tx) => {
          // An unpaid order still consumed stock and a discount use at
          // checkout — deleting it without giving those back would leak both
          // forever (same treatment as the seller cancel and the cron expiry).
          await restockOrderItems(tx, order.id);
          await releaseDiscountUse(tx, order.id);
          await tx.order.delete({ where: { id: order.id } }); // cascades OrderItem + OrderEvent
        });
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
        // Same guard, stronger shape: ANY recorded Payment row (including
        // failed attempts) is a money trail — match delete_order's standard.
        const paymentRows = await db.payment.count({
          where: { order: { OR: [{ buyerId: target.id }, ...(targetStoreIds.length > 0 ? [{ storeId: { in: targetStoreIds } }] : [])] } },
        });
        if (paymentRows > 0) {
          return Response.json({ error: `This account has ${paymentRows} payment record(s) — financial records cannot be deleted. Suspend the account instead.` }, { status: 409 });
        }
        const paidSubscriptions = targetStoreIds.length > 0
          ? await db.subscriptionPayment.count({ where: { storeId: { in: targetStoreIds }, status: 'paid' } })
          : 0;
        if (paidSubscriptions > 0) {
          return Response.json({ error: `This seller paid ${paidSubscriptions} subscription payment(s) — financial records cannot be deleted. Suspend the account instead.` }, { status: 409 });
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
          // Unpaid subscription checkouts (never money) — paid ones block the delete above.
          db.subscriptionPayment.deleteMany({ where: { storeId: { in: storeIds }, status: { not: 'paid' } } }),
          // Finally the account itself — schema cascades Account, stores →
          // products → images/variants/events/reviews, cart, wishlist,
          // notifications and addresses.
          db.user.delete({ where: { id: target.id } }),
        ]);
        await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'user_deleted', target: target.email, detail: `${storeIds.length} store(s) removed` });
        return Response.json({ ok: true });
      }
      case 'billing_exempt': {
        // Free access: the store sells and keeps its tools without paying.
        const on = String(body.value ?? '') === 'on';
        const note = String(body.note ?? '').trim().slice(0, 200) || null;
        const store = await db.store.findUnique({ where: { id: targetId }, select: { id: true, name: true, userId: true, status: true, billingExempt: true, trialEndsAt: true, accessUntil: true, user: { select: { role: true } } } });
        if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });
        if (!on && store.user.role === 'ADMIN') {
          return Response.json({ error: 'The administrator’s own store is always free.' }, { status: 409 });
        }
        if (store.billingExempt === on) {
          return Response.json({ error: on ? 'This store already has free access.' : 'This store does not have free access.' }, { status: 409 });
        }
        // A store that had free access from the day it was approved never had
        // its one-time free trial: ending free access starts it now.
        const startsTrial = !on && store.status === 'active' && !store.trialEndsAt && !store.accessUntil;
        await db.store.update({ where: { id: store.id }, data: { billingExempt: on, billingExemptNote: on ? (note ?? 'Free access granted by Green Gate') : null, billingNotice: null, ...(startsTrial ? trialStartData() : {}) } });
        void notify({
          userId: store.userId,
          type: 'subscription',
          title: on ? 'Free access granted' : 'Free access ended',
          body: on
            ? `Green Gate gave “${store.name}” free access — no subscription payment is needed.`
            : startsTrial
              ? `Free access for “${store.name}” has ended and your 30-day free trial has started. Subscribe in your seller dashboard before it ends to keep your store and products live.`
              : `Free access for “${store.name}” has ended. Check your seller dashboard to keep your store and products live.`,
          link: '/dashboard',
        });
        await audit({ actorId: session.user.id, actorEmail: session.user.email, action: on ? 'billing_exempt_granted' : 'billing_exempt_removed', target: store.id, detail: `${store.name}${note ? ` · ${note}` : ''}` });
        return Response.json({ ok: true });
      }
      case 'discount_code_admin': {
        // Switch a seller's discount code off (abuse, misleading offer) or back on.
        const off = String(body.value ?? '') === 'off';
        const code = await db.discountCode.findUnique({ where: { id: targetId }, select: { id: true, code: true, disabledByAdmin: true, store: { select: { id: true, name: true, userId: true } } } });
        if (!code) return Response.json({ error: 'Code not found' }, { status: 404 });
        if (code.disabledByAdmin === off) {
          return Response.json({ error: off ? 'This code is already switched off.' : 'This code is not switched off by Green Gate.' }, { status: 409 });
        }
        await db.discountCode.update({ where: { id: code.id }, data: { disabledByAdmin: off } });
        void notify({
          userId: code.store.userId,
          type: 'discount_code',
          title: off ? `Discount code ${code.code} switched off` : `Discount code ${code.code} allowed again`,
          body: off
            ? `Green Gate switched off the code ${code.code} for “${code.store.name}”. Buyers can no longer use it. Message Green Gate from your dashboard if you have questions.`
            : `Green Gate allowed the code ${code.code} for “${code.store.name}” again — switch it on in your dashboard when you want buyers to use it.`,
          link: '/dashboard',
        });
        await audit({ actorId: session.user.id, actorEmail: session.user.email, action: off ? 'discount_code_disabled' : 'discount_code_allowed', target: code.store.id, detail: `${code.code} · ${code.store.name}` });
        return Response.json({ ok: true });
      }
      case 'store_verified': {
        // "Verified seller" badge: only after the administrator has checked the
        // seller's identity and bank details (the console asks before setting it).
        const on = String(body.value ?? '') === 'on';
        const note = String(body.note ?? '').trim().slice(0, 200) || null;
        const store = await db.store.findUnique({ where: { id: targetId }, select: { id: true, name: true, userId: true, verifiedAt: true } });
        if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });
        if (Boolean(store.verifiedAt) === on) {
          return Response.json({ error: on ? 'This store is already verified.' : 'This store is not verified.' }, { status: 409 });
        }
        await db.store.update({ where: { id: store.id }, data: on ? { verifiedAt: new Date(), verifiedNote: note } : { verifiedAt: null, verifiedNote: null } });
        void notify({
          userId: store.userId,
          type: 'store_verified',
          title: on ? 'Your store is a Verified seller' : 'Verified seller badge removed',
          body: on
            ? `Green Gate checked “${store.name}” and your store now shows the Verified seller badge to buyers.`
            : `The Verified seller badge was removed from “${store.name}”. Message Green Gate from your dashboard if you have questions.`,
          link: '/dashboard',
        });
        await audit({ actorId: session.user.id, actorEmail: session.user.email, action: on ? 'store_verified' : 'store_unverified', target: store.id, detail: `${store.name}${note ? ` · ${note}` : ''}` });
        return Response.json({ ok: true });
      }
      case 'send_seller_message': {
        const text = cleanMessageText(body.message);
        if (!text.ok) return Response.json({ error: text.error }, { status: 400 });
        const store = await db.store.findUnique({ where: { id: targetId }, select: { id: true, name: true, userId: true } });
        if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });
        const message = await db.sellerMessage.create({ data: { storeId: store.id, fromAdmin: true, authorId: session.user.id, body: text.value } });
        // Opening a thread to reply means the seller's messages were read.
        await db.sellerMessage.updateMany({ where: { storeId: store.id, fromAdmin: false, readAt: null }, data: { readAt: new Date() } });
        void notify({ userId: store.userId, type: 'seller_message', title: 'Message from Green Gate', body: text.value.slice(0, 140), link: '/dashboard' });
        await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'admin_message_sent', target: store.id, detail: `${store.name} · ${text.value.length} characters` });
        return Response.json({ ok: true, id: message.id });
      }
      case 'mark_seller_messages_read': {
        const res = await db.sellerMessage.updateMany({ where: { storeId: targetId, fromAdmin: false, readAt: null }, data: { readAt: new Date() } });
        await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'seller_messages_marked_read', target: targetId, detail: `${res.count} message(s)` });
        return Response.json({ ok: true, updated: res.count });
      }
      case 'release_payout': {
        // Escrow release (additive): the admin can free a held payout when
        // human judgement says the parcel shipped (e.g. the courier missed a
        // scan and the 48h auto-release has not fired yet). Every other guard
        // (refunded/cancelled hold) still applies first.
        const check = await db.payout.findUnique({ where: { id: targetId }, include: { order: { select: { number: true, status: true } } } });
        if (!check) return Response.json({ error: 'Payout not found' }, { status: 404 });
        if (check.releasedAt) return Response.json({ error: 'This payout is already released.' }, { status: 409 });
        const rel = await releaseEscrowForOrder(check.orderId, 'admin');
        if (!rel.ok) return Response.json({ error: `Cannot release: ${rel.reason ?? 'unknown reason'}` }, { status: 409 });
        await audit({ actorId: session.user.id, actorEmail: session.user.email ?? 'admin', action: 'payout_released_from_escrow', target: check.reference, detail: `order ${check.order?.number ?? check.orderId} released by admin` }).catch(() => undefined);
        return Response.json({ ok: true, released: true, reference: check.reference });
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
