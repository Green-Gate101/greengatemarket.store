import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireRole, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { algoliaConfigured } from '@/lib/algolia';

export const dynamic = 'force-dynamic';

/**
 * In-app monitor (read-only, administrator-only): a live operations snapshot
 * that goes beyond the public /api/health config check. Reports service
 * reachability with database latency, how active stores configure their own
 * payment processors (PayFast, Yoco, Mastercard, SnapScan, Stripe, bank
 * transfer), and the operational queues that need attention — store
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
        detail: 'PayFast, Yoco, Mastercard, SnapScan, Stripe payment links + bank transfer',
      },
      {
        service: 'payments (in-system cards — Yoco Checkout API)',
        ok: true,
        detail: yocoConnected > 0 ? `${yocoConnected} seller(s) connected — Mastercard & Visa accepted in checkout` : 'no seller connected yet — sellers add their Yoco secret key in Seller dashboard → Payment details',
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
      select: { payoutProvider: true, payoutLink: true, yocoSecretKey: true },
    });
    const buckets = new Map<string, { stores: number; withLink: number }>();
    let yocoConnected = 0;
    for (const row of payoutRows) {
      const key = row.payoutProvider?.trim() || 'bank_transfer';
      const bucket = buckets.get(key) ?? { stores: 0, withLink: 0 };
      bucket.stores += 1;
      if (row.payoutLink) bucket.withLink += 1;
      buckets.set(key, bucket);
      if (row.yocoSecretKey) yocoConnected += 1;
    }
    const LABELS: Record<string, string> = {
      bank_transfer: 'Bank transfer (EFT)',
      payfast: 'PayFast',
      yoco: 'Yoco',
      mastercard: 'Mastercard',
      snapscan: 'SnapScan',
      stripe: 'Stripe',
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

    const status = checks.every((c) => c.ok) ? 'ok' : 'degraded';
    return Response.json({
      status,
      time: new Date().toISOString(),
      latencyMs,
      checks,
      adoption,
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
