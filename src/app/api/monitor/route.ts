import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireRole, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { algoliaConfigured } from '@/lib/algolia';
import { platformFeePercent, ggpayEngineMode } from '@/lib/ggpay';

export const dynamic = 'force-dynamic';

/**
 * In-app monitor (read-only, administrator-only): a live operations snapshot
 * that goes beyond the public /api/health config check. Reports service
 * reachability with database latency, how active stores configure their own
 * payment processors (in-app PayFast, Ozow instant EFT, Yoco cards,
 * Mastercard, bank transfer), and the operational queues that need attention — store
 * applications, product approvals, orders awaiting payment.
 *
 * Every number is computed from real database rows on each request; no
 * sampling, no caching, and no credential value is ever included in output.
 */
export async function GET(req: NextRequest) {
  try {
    await bootstrap();
    await requireRole('ADMIN');

    // Database reachability + round-trip latency.
    let dbOk = true;
    const startedAt = Date.now();
    try {
      await db.$queryRaw`SELECT 1`;
    } catch {
      dbOk = false;
    }
    const latencyMs = Math.max(0, Date.now() - startedAt);

    const checks: { service: string; ok: boolean; detail: string }[] = [
      { service: 'database', ok: dbOk, detail: dbOk ? `connected (${latencyMs} ms)` : 'unavailable' },
      {
        service: 'email (Resend)',
        ok: Boolean(process.env.RESEND_API_KEY),
        detail: process.env.RESEND_API_KEY ? 'configured' : 'not configured — set RESEND_API_KEY',
      },
      {
        service: 'search (Algolia)',
        ok: true,
        detail: algoliaConfigured ? 'Algolia active' : 'database search fallback active (no action needed)',
      },
      {
        service: 'delivery (The Courier Guy)',
        ok: true,
        detail: process.env.COURIER_GUY_API_KEY ? 'live merchant rates' : 'live public rates + flat-rate fallback',
      },
      {
        service: 'payments (marketplace PayFast)',
        ok: true,
        detail: process.env.PAYFAST_MERCHANT_ID ? 'card payments live' : 'not configured — sellers can still take payments with their own processors; bank transfer always active',
      },
      {
        service: 'payments (seller processors)',
        ok: true,
        detail: 'In-app PayFast, Ozow instant EFT, Yoco cards, Mastercard + bank transfer',
      },
      {
        service: 'google sign-in',
        ok: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
        detail: process.env.GOOGLE_CLIENT_ID ? 'configured' : 'requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET',
      },
    ];

    // Payment-processor adoption across ACTIVE stores — one lightweight query,
    // aggregated in memory so null providers fold into the bank-transfer default.
    const payoutRows = await db.store.findMany({
      where: { status: 'active' },
      select: { payoutProvider: true, payoutLink: true, yocoSecretKey: true, payfastMerchantId: true, payfastMerchantKeyEnc: true, ozowSiteCode: true, ozowPrivateKeyEnc: true },
    });
    const buckets = new Map<string, { stores: number; withLink: number }>();
    let yocoConnected = 0;
    let payfastConnected = 0;
    let ozowConnected = 0;
    for (const row of payoutRows) {
      const key = row.payoutProvider?.trim() || 'bank_transfer';
      const bucket = buckets.get(key) ?? { stores: 0, withLink: 0 };
      bucket.stores += 1;
      if (row.payoutLink) bucket.withLink += 1;
      buckets.set(key, bucket);
      if (row.yocoSecretKey) yocoConnected += 1;
      if (row.payfastMerchantId && row.payfastMerchantKeyEnc) payfastConnected += 1;
      if (row.ozowSiteCode && row.ozowPrivateKeyEnc) ozowConnected += 1;
    }
    // In-system card payments status — appended here because the count comes
    // from the payout rows queried above.
    checks.push({
      service: 'payments (in-system cards — Yoco Checkout API)',
      ok: true,
      detail: yocoConnected > 0 ? `${yocoConnected} seller(s) connected — Mastercard & Visa accepted in checkout` : 'no seller connected yet — sellers add their Yoco secret key in Seller dashboard → Payment details',
    });
    checks.push({
      service: 'payments (in-app PayFast Onsite — seller accounts)',
      ok: true,
      detail: payfastConnected > 0 ? `${payfastConnected} seller(s) connected — card & SiD instant EFT paid inside the app` : 'no seller connected yet — sellers add their PayFast merchant id/key in Seller dashboard → Payment details',
    });
    checks.push({
      service: 'payments (in-app Ozow instant EFT — seller accounts)',
      ok: true,
      detail: ozowConnected > 0 ? `${ozowConnected} seller(s) connected — bank instant EFT paid inside the app` : 'no seller connected yet — sellers add their Ozow site code/private key in Seller dashboard → Payment details',
    });
    const LABELS: Record<string, string> = {
      bank_transfer: 'Bank transfer (EFT)',
      payfast: 'PayFast',
      ozow: 'Ozow (Instant EFT)',
      yoco: 'Yoco',
      mastercard: 'Mastercard',
      other: 'Other processor',
    };
    const adoption = [...buckets.entries()]
      .map(([provider, b]) => ({ provider, label: LABELS[provider] ?? 'Other processor', ...b }))
      .sort((a, b) => b.stores - a.stores);

    // Operational queues + marketplace totals.
    const [pendingStores, pendingProducts, awaitingPayment, users, sellers, banned, activeStores, liveProducts, orders] = await Promise.all([
      db.store.count({ where: { status: 'pending' } }),
      db.product.count({ where: { status: 'pending_review' } }),
      db.order.count({ where: { status: 'pending_payment' } }),
      db.user.count(),
      db.user.count({ where: { role: 'SELLER' } }),
      db.user.count({ where: { banned: true } }),
      db.store.count({ where: { status: 'active' } }),
      db.product.count({ where: { status: 'approved' } }),
      db.order.count(),
    ]);

    // GGPay in-app payments + seller payouts — the money layer's live vital
    // signs. Every figure from real rows; no credentials in output.
    const [paymentByStatus, paymentByProvider, payoutByStatus] = await Promise.all([
      db.payment.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amountCents: true } }),
      db.payment.groupBy({ by: ['provider'], where: { status: 'paid' }, _count: { _all: true } }),
      db.payout.groupBy({ by: ['status'], _count: { _all: true }, _sum: { netCents: true } }),
    ]);
    const payOf = (s: string) => paymentByStatus.find((p) => p.status === s);
    const poOf = (s: string) => payoutByStatus.find((p) => p.status === s);
    const paidPayments = payOf('paid')?._count._all ?? 0;
    const failedPayments = payOf('failed')?._count._all ?? 0;
    const payments = {
      paid: paidPayments,
      failed: failedPayments,
      successRatePct: paidPayments + failedPayments > 0 ? Math.round((paidPayments * 100) / (paidPayments + failedPayments)) : null,
      volumeCents: payOf('paid')?._sum.amountCents ?? 0,
      byProvider: paymentByProvider.map((p) => ({ provider: p.provider, count: p._count._all })),
    };
    const payouts = {
      pending: { count: poOf('pending')?._count._all ?? 0, netCents: poOf('pending')?._sum.netCents ?? 0 },
      processing: { count: poOf('processing')?._count._all ?? 0, netCents: poOf('processing')?._sum.netCents ?? 0 },
      paid: { count: poOf('paid')?._count._all ?? 0, netCents: poOf('paid')?._sum.netCents ?? 0 },
      feePercent: platformFeePercent(),
    };

    // GGPay status check — placed here because the settled-payment count comes
    // from the queries above (keeps the previous TDZ deploy failure class out).
    checks.push({
      service: 'payments (in-app GGPay card processor)',
      ok: true,
      detail: ggpayEngineMode() === 'live'
        ? `LIVE acquirer — ${paidPayments} in-app card payment(s) settled; seller payouts queued (fee ${platformFeePercent()}%)`
        : `TEST MODE — only published sandbox test cards are decided on; REAL cards are refused so no buyer can "pay" without money moving. Add a production acquirer key (GGPAY_ACQUIRER_KEY) to charge real cards. ${paidPayments} test settlement(s) so far.`,
    });

    const status = checks.every((c) => c.ok) ? 'ok' : 'degraded';
    return Response.json({
      status,
      time: new Date().toISOString(),
      latencyMs,
      checks,
      adoption,
      payments,
      payouts,
      paymentEngine: { ggpayMode: ggpayEngineMode() },
      queue: { pendingStores, pendingProducts, awaitingPayment },
      totals: { users, sellers, activeStores, liveProducts, orders, banned },
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('monitor GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not build the monitor snapshot.' }, { status: 500 });
  }
}
