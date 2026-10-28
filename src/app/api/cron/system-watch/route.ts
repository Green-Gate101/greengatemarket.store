import { NextRequest } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { algoliaConfigured } from '@/lib/algolia';
import { ggpayAcceptsCards, ggpayEngineMode, platformFeePercent } from '@/lib/ggpay';
import { emailConfigured } from '@/lib/email';
import { payfastEnabled } from '@/lib/payfast';
import { recordMonitorIncidents } from '@/lib/monitor-incidents';
import { sharedLimiterStatus } from '@/lib/rate-limit';
import { decryptSecret } from '@/lib/secret-box';
import { yocoKeyUsable } from '@/lib/yoco';
import { sweepEscrowReleases } from '@/lib/escrow';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Always-on system watch (additive — nothing existing changes).
 *
 * A cron (vercel.json) hits this route and runs the deep health battery the
 * public /api/health only reports configuration for:
 *   - database reachability + round-trip latency
 *   - order pipeline health: payment claims stuck in processing_payment
 *     (a crash mid-charge leaves them; the buyer retry releases one claim,
 *     the watch catches the ones nobody retried) and the awaiting-payment
 *     backlog
 *   - payment rails posture (in-app engine mode, marketplace PayFast,
 *     seller-connected Yoco / PayFast / Ozow counts) — money trails the
 *     marketplace depends on
 *   - search: a REAL Algolia query (every 5th run — keeps the free-tier
 *     operation budget healthy; the storefront falls back to database search
 *     between probes without any user-visible failure)
 *   - email + Google sign-in configuration drift
 *
 * Failures open MonitorIncident rows and email the admin exactly once per
 * episode (shared state machine in src/lib/monitor-incidents.ts — the admin
 * console's every-second System monitor view feeds the same machine, so
 * incidents are tracked per-second while the tab is open too).
 *
 * NOTE on cadence: Vercel's Hobby plan only allows once-per-day crons, so
 * the vercel.json schedule is daily. For a true around-the-clock watch,
 * point any external pinger (UptimeRobot / cron-job.org) at this URL every
 * minute with `Authorization: Bearer <CRON_SECRET>` — or upgrade to Pro.
 *
 * Auth: when CRON_SECRET is configured (production), only calls carrying
 * `Authorization: Bearer <CRON_SECRET>` are accepted; without it (local
 * development) the route is open so the watch can be exercised end-to-end.
 */

const STALE_CLAIM_MS = 60 * 60_000; // a payment claim older than 60 min is a fault
const ALGOLIA_PROBE_EVERY = 5; // probe the live search index on every 5th run

interface WatchCheck {
  check: string;
  ok: boolean;
  detail: string;
}

export async function GET(req: NextRequest) {
  try {
    const secret = process.env.CRON_SECRET;
    // Fail closed on any Vercel deployment (prod AND preview — both share the
    // production database): an unauthenticated cron endpoint would let anyone
    // fire the escrow sweep, courier retries and monitoring at will. Local dev
    // (no VERCEL_ENV) stays open for testing.
    if (process.env.VERCEL_ENV && !secret) {
      return Response.json({ error: 'Cron is not configured on this deployment (CRON_SECRET missing).' }, { status: 503 });
    }
    if (secret) {
      const auth = req.headers.get('authorization') ?? '';
      const expected = `Bearer ${secret}`;
      const same = auth.length === expected.length && timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
      if (!same) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
    await bootstrap();

    const runAtMinute = new Date().getUTCMinutes();
    const checks: WatchCheck[] = [];

    // 1. Database — reachability + latency.
    try {
      const t0 = Date.now();
      await db.$queryRaw`SELECT 1`;
      const dbLatency = Date.now() - t0;
      checks.push({ check: 'database', ok: true, detail: `connected (${dbLatency} ms)` });
    } catch (e) {
      checks.push({ check: 'database', ok: false, detail: `unavailable: ${e instanceof Error ? e.message : 'error'}` });
    }

    // 2. Order pipeline — stuck payment claims + backlog shape.
    try {
      const staleCutoff = new Date(Date.now() - STALE_CLAIM_MS);
      const [staleClaims, backlog] = await Promise.all([
        db.order.count({ where: { paymentStatus: 'processing_payment', updatedAt: { lt: staleCutoff } } }),
        db.order.count({ where: { status: 'pending_payment', paymentStatus: 'awaiting_payment' } }),
      ]);
      checks.push({
        check: 'order pipeline',
        ok: staleClaims === 0,
        detail: staleClaims > 0
          ? `${staleClaims} payment claim(s) stuck >60 min — a charge may have crashed mid-flight`
          : `clean — ${backlog} order(s) awaiting payment (normal)`,
      });
    } catch (e) {
      checks.push({ check: 'order pipeline', ok: false, detail: `query failed: ${e instanceof Error ? e.message : 'error'}` });
    }

    // 3. Money rails — configured posture of every payment path.
    try {
      const [yocoCount, payfastCount, ozowCount] = await Promise.all([
        db.store.count({ where: { status: 'active', yocoSecretKey: { not: null } } }),
        db.store.count({ where: { status: 'active', payfastMerchantId: { not: null }, payfastMerchantKeyEnc: { not: null } } }),
        db.store.count({ where: { status: 'active', ozowSiteCode: { not: null }, ozowPrivateKeyEnc: { not: null } } }),
      ]);
      // Live vs test Yoco keys: test keys are refused on the live site, so
      // those sellers cannot take Yoco payments until they save a live key.
      const yocoKeys = await db.store.findMany({ where: { status: 'active', yocoSecretKey: { not: null } }, select: { yocoSecretKey: true }, take: 1000 });
      const yocoLive = yocoKeys.filter((s) => yocoKeyUsable(decryptSecret(s.yocoSecretKey))).length;
      const mode = ggpayEngineMode();
      checks.push({
        check: 'payment rails',
        ok: true, // posture is informational — real-money rails are seller-owned and always live
        detail: `in-app engine: ${mode === 'live' ? 'live credential present (charges refused until acquirer wired)' : (ggpayAcceptsCards() ? 'sandbox (this deployment only)' : 'off — card form hidden, every card refused')} · marketplace PayFast: ${payfastEnabled() ? 'configured' : 'not set'} · sellers connected — Yoco ${yocoCount} (${yocoLive} usable live key(s), ${yocoKeys.length - yocoLive} test/unreadable key(s) refused), PayFast ${payfastCount}, Ozow ${ozowCount} · bank transfer not offered (processors only) · fee ${platformFeePercent()}%`,
      });
    } catch (e) {
      checks.push({ check: 'payment rails', ok: false, detail: `query failed: ${e instanceof Error ? e.message : 'error'}` });
    }

    // 4. Search — a REAL index query on every 5th run.
    if (runAtMinute % ALGOLIA_PROBE_EVERY === 0) {
      if (!algoliaConfigured) {
        checks.push({ check: 'search', ok: true, detail: 'database search fallback active (no action needed)' });
      } else {
        try {
          const { searchProductIds } = await import('@/lib/algolia');
          const ids = await searchProductIds('system-watch-probe');
          checks.push({ check: 'search', ok: ids !== null, detail: ids !== null ? `Algolia query ok (${ids.length} hits for probe term)` : 'Algolia query failed — storefront auto-falls-back to database search' });
        } catch (e) {
          checks.push({ check: 'search', ok: false, detail: `probe failed: ${e instanceof Error ? e.message : 'error'}` });
        }
      }
    }

    // 5. Shared (cross-instance) rate limiter — brute-force protection on
    // sign-in, checkout and payments only holds while Redis answers.
    const limiter = await sharedLimiterStatus();
    checks.push({ check: 'shared rate limiter (Redis)', ok: limiter.ok, detail: limiter.detail });

    // 6. Email + Google configuration drift.
    checks.push({
      check: 'email (Resend)',
      ok: emailConfigured,
      detail: emailConfigured ? 'configured' : 'not configured — alerts and order emails cannot send',
    });
    checks.push({
      check: 'google sign-in',
      ok: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      detail: process.env.GOOGLE_CLIENT_ID ? 'configured' : 'not configured — password sign-in remains available',
    });

    // Escrow release sweep (additive): releases held seller earnings the
    // moment The Courier Guy confirms collection (or the 48h auto-release
    // fires for a missed scan). Rides this cron daily + any external pinger.
    const escrow = await sweepEscrowReleases(25).catch(() => null);

    // --- Shared incident state machine (opens/closes rows, alerts once) ---
    const { newlyOpened, recovered } = await recordMonitorIncidents(checks);

    const failing = checks.filter((c) => !c.ok).length;
    return Response.json({
      ok: failing === 0,
      time: new Date().toISOString(),
      checks,
      escrow: escrow ? { checked: escrow.checked, released: escrow.released, viaScan: escrow.viaScan, viaAuto: escrow.viaAuto } : null,
      incidents: { newlyOpened, recovered },
      alerting: { email: Boolean(process.env.ADMIN_EMAIL && emailConfigured) },
    });
  } catch (e) {
    console.error('system-watch error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'System watch pass failed.' }, { status: 500 });
  }
}
