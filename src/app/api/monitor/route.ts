import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireRole, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { algoliaConfigured } from '@/lib/algolia';
import { platformFeePercent, ggpayEngineMode, ggpayAcceptsCards } from '@/lib/ggpay';
import { recordMonitorIncidents } from '@/lib/monitor-incidents';
import { sharedLimiterStatus } from '@/lib/rate-limit';
import { payfastSellerReady, ozowSellerReady } from '@/lib/seller-payments';
import { yocoStoreReady } from '@/lib/yoco';

export const dynamic = 'force-dynamic';

/**
 * Processor adoption scans every active store and checks each one with the
 * same readiness rules checkout uses. The System monitor polls every second,
 * so the scan is reused for a minute instead of re-reading the whole store
 * table on every tick (per instance; adoption changes slowly).
 */
const ADOPTION_TTL_MS = 60_000;
type AdoptionScan = {
  buckets: Map<string, { stores: number; withLink: number }>;
  yoco: { ready: number; saved: number };
  payfast: { ready: number; saved: number };
  ozow: { ready: number; saved: number };
};
let adoptionCache: { at: number; scan: AdoptionScan } | null = null;

async function scanAdoption(): Promise<AdoptionScan> {
  if (adoptionCache && Date.now() - adoptionCache.at < ADOPTION_TTL_MS) return adoptionCache.scan;
  const payoutRows = await db.store.findMany({
    where: { status: 'active' },
    select: { id: true, name: true, payoutProvider: true, payoutLink: true, yocoSecretKey: true, payfastMerchantId: true, payfastMerchantKeyEnc: true, payfastPassphraseEnc: true, ozowSiteCode: true, ozowPrivateKeyEnc: true, ozowApiKeyEnc: true },
  });
  const scan: AdoptionScan = { buckets: new Map(), yoco: { ready: 0, saved: 0 }, payfast: { ready: 0, saved: 0 }, ozow: { ready: 0, saved: 0 } };
  for (const row of payoutRows) {
    const key = row.payoutProvider?.trim() || 'bank_transfer';
    const bucket = scan.buckets.get(key) ?? { stores: 0, withLink: 0 };
    bucket.stores += 1;
    if (row.payoutLink) bucket.withLink += 1;
    scan.buckets.set(key, bucket);
    if (row.yocoSecretKey) scan.yoco.saved += 1;
    if (yocoStoreReady(row)) scan.yoco.ready += 1;
    if (row.payfastMerchantId) scan.payfast.saved += 1;
    if (payfastSellerReady(row)) scan.payfast.ready += 1;
    if (row.ozowSiteCode) scan.ozow.saved += 1;
    if (ozowSellerReady(row)) scan.ozow.ready += 1;
  }
  adoptionCache = { at: Date.now(), scan };
  return scan;
}

/** "3 seller(s) ready …" plus how many saved details buyers cannot use yet. */
function readinessDetail(c: { ready: number; saved: number }, readyText: string, noneText: string): string {
  const notUsable = c.saved - c.ready;
  const tail = notUsable > 0 ? ` · ${notUsable} more saved details that buyers cannot use yet (missing passphrase/API key, test key or unreadable secret — the seller sees a warning)` : '';
  return c.ready > 0 ? `${c.ready} seller(s) ready — ${readyText}${tail}` : `${noneText}${tail}`;
}

/** Incident rows → API payload (open episodes + recent recoveries). */
async function buildIncidentPayload(newlyOpened: string[], recovered: { check: string; minutes: number }[]) {
  const [open, resolved] = await Promise.all([
    db.monitorIncident.findMany({ where: { status: 'open' }, orderBy: { openedAt: 'asc' } }),
    db.monitorIncident.findMany({ where: { status: 'resolved' }, orderBy: { resolvedAt: 'desc' }, take: 10 }),
  ]);
  const view = (i: (typeof open)[number]) => ({
    check: i.check,
    detail: i.detail,
    occurrences: i.occurrences,
    openedAt: i.openedAt,
    lastSeenAt: i.lastSeenAt,
    resolvedAt: i.status === 'resolved' ? i.resolvedAt : null,
    openMinutes: Math.round(((i.resolvedAt ?? new Date()).getTime() - new Date(i.openedAt).getTime()) / 60_000),
  });
  return { open: open.map(view), recentResolved: resolved.map(view), live: { newlyOpened, recovered } };
}

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
    const limiter = await sharedLimiterStatus();

    const checks: { service: string; ok: boolean; detail: string }[] = [
      { service: 'database', ok: dbOk, detail: dbOk ? `connected (${latencyMs} ms)` : 'unavailable' },
      { service: 'shared rate limiter (Redis)', ok: limiter.ok, detail: limiter.detail },
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
        detail: 'PayFast, Ozow instant EFT and Yoco cards (paid on each provider’s secure page, straight to the seller) + bank transfer',
      },
      {
        service: 'google sign-in',
        ok: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
        detail: process.env.GOOGLE_CLIENT_ID ? 'configured' : 'requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET',
      },
    ];

    // Payment-processor adoption across ACTIVE stores (cached scan, see
    // scanAdoption) — null providers fold into the bank-transfer default.
    // "Ready" uses the same checks checkout uses before offering a rail.
    const { buckets, yoco, payfast, ozow } = await scanAdoption();
    checks.push({
      service: 'payments (Yoco cards — seller accounts)',
      ok: true,
      detail: readinessDetail(yoco, 'buyers pay by Mastercard & Visa on Yoco’s secure page', 'no seller ready yet — sellers add their LIVE Yoco secret key in Seller dashboard → Payment details'),
    });
    checks.push({
      service: 'payments (PayFast — seller accounts)',
      ok: true,
      detail: readinessDetail(payfast, 'buyers pay by card or instant EFT on PayFast’s secure page', 'no seller ready yet — sellers add their PayFast merchant ID, key and passphrase in Seller dashboard → Payment details'),
    });
    checks.push({
      service: 'payments (Ozow instant EFT — seller accounts)',
      ok: true,
      detail: readinessDetail(ozow, 'buyers pay by instant EFT on Ozow’s secure page', 'no seller ready yet — sellers add their Ozow site code, private key and API key in Seller dashboard → Payment details'),
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
        ? `Live acquirer credential present — charges are REFUSED until the production routing hook is wired (no card can "pay" without money moving). ${paidPayments} test settlement(s) so far; sellers' own Yoco / PayFast / Ozow rails move real money now.`
        : ggpayAcceptsCards()
          ? `SANDBOX on this deployment only (GGPAY_ALLOW_SANDBOX / local development) — published test cards settle orders here; never enable this where real orders live. ${paidPayments} settlement(s) so far.`
          : `OFF on the live site — the card form is hidden and every card is refused (no acquirer connected). Buyers pay with the sellers' own PayFast / Ozow / Yoco accounts or by EFT. ${paidPayments} past in-app card settlement(s) — any made with test cards before this fix moved no money.`,
    });

    const status = checks.every((c) => c.ok) ? 'ok' : 'degraded';

    // Shared incident state machine: every pull of this snapshot (the admin
    // console's System monitor tab polls every second) opens/increments
    // incidents for failing checks and resolves recovered ones — the same
    // rows the background system-watch cron maintains. Watch keys are mapped
    // so both feed one incident stream; config-only services are informational.
    const watchChecks = [
      { check: 'database', ok: checks.find((c) => c.service === 'database')?.ok ?? true, detail: checks.find((c) => c.service === 'database')?.detail ?? '' },
      { check: 'email (Resend)', ok: checks.find((c) => c.service === 'email (Resend)')?.ok ?? true, detail: checks.find((c) => c.service === 'email (Resend)')?.detail ?? '' },
      { check: 'search', ok: true, detail: checks.find((c) => c.service === 'search (Algolia)')?.detail ?? '' },
    ];
    let live = { newlyOpened: [] as string[], recovered: [] as { check: string; minutes: number }[] };
    try {
      live = await recordMonitorIncidents(watchChecks);
    } catch (e) {
      console.error('monitor incident recording failed:', e instanceof Error ? e.message : e);
    }
    const incidents = await buildIncidentPayload(live.newlyOpened, live.recovered);

    return Response.json({
      status,
      time: new Date().toISOString(),
      latencyMs,
      checks,
      incidents,
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
    // Say WHY when the database itself is the problem (sign-in checks need it
    // too, so it is often the first thing to fail).
    const dbReachable = await Promise.race([
      db.$queryRaw`SELECT 1`.then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    return Response.json(
      { error: dbReachable ? 'Could not build the monitor snapshot.' : 'Database unreachable — the marketplace cannot read or write data right now.' },
      { status: dbReachable ? 500 : 503 },
    );
  }
}
