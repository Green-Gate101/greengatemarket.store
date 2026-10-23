import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { audit } from '@/lib/audit';
import { algoliaConfigured } from '@/lib/algolia';
import { ggpayEngineMode, platformFeePercent } from '@/lib/ggpay';
import { emailConfigured, sendSystemAlertEmail } from '@/lib/email';
import { payfastEnabled } from '@/lib/payfast';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Always-on system watch (additive — nothing existing changes).
 *
 * Vercel Cron hits this route every minute (vercel.json crons) and runs the
 * deep health battery the public /api/health only reports configuration for:
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
 * Every failing check opens (or increments) a MonitorIncident row; every
 * recovered check closes its incident. A NEW incident emails the admin once
 * (Resend), and a recovery emails once — an outage can never spam more than
 * one "failing" and one "recovered" message per check per episode.
 *
 * Auth: when CRON_SECRET is configured (production), only calls carrying
 * `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends it automatically)
 * are accepted; without it (local development) the route is open so the
 * watch can be exercised end-to-end.
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
    if (secret) {
      const auth = req.headers.get('authorization') ?? '';
      if (auth !== `Bearer ${secret}`) {
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
      const mode = ggpayEngineMode();
      checks.push({
        check: 'payment rails',
        ok: true, // posture is informational — real-money rails are seller-owned and always live
        detail: `in-app engine: ${mode === 'live' ? 'live credential present (charges refused until acquirer wired)' : 'test mode (sandbox cards only)'} · marketplace PayFast: ${payfastEnabled() ? 'configured' : 'not set'} · sellers connected — Yoco ${yocoCount}, PayFast ${payfastCount}, Ozow ${ozowCount} · bank transfer always on · fee ${platformFeePercent()}%`,
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

    // 5. Email + Google configuration drift.
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

    // --- Incident state machine: open/increment failures, close recoveries ---
    const now = new Date();
    const newlyOpened: string[] = [];
    const recovered: { check: string; minutes: number }[] = [];

    // Only touch incident rows when the database itself answered above.
    if (checks.find((c) => c.check === 'database')?.ok) {
      const failedChecks = checks.filter((c) => !c.ok);
      const openIncidents = await db.monitorIncident.findMany({ where: { status: 'open' } });

      for (const failed of failedChecks) {
        const existing = openIncidents.find((i) => i.check === failed.check);
        if (existing) {
          await db.monitorIncident.update({ where: { id: existing.id }, data: { occurrences: { increment: 1 }, lastSeenAt: now, detail: failed.detail } });
        } else {
          await db.monitorIncident.create({ data: { check: failed.check, detail: failed.detail } });
          newlyOpened.push(failed.check);
        }
      }

      for (const open of openIncidents) {
        if (!failedChecks.some((f) => f.check === open.check)) {
          await db.monitorIncident.update({ where: { id: open.id }, data: { status: 'resolved', resolvedAt: now } });
          recovered.push({ check: open.check, minutes: Math.round((now.getTime() - new Date(open.openedAt).getTime()) / 60_000) });
        }
      }
    }

    // --- Alert once per episode (email + audit) ---
    const adminEmail = process.env.ADMIN_EMAIL ?? '';
    if (adminEmail && emailConfigured) {
      for (const checkName of newlyOpened) {
        const failed = checks.find((c) => c.check === checkName);
        await sendSystemAlertEmail({ to: adminEmail, kind: 'incident', check: checkName, detail: failed?.detail ?? 'failing' }).catch(() => false);
      }
      for (const r of recovered) {
        await sendSystemAlertEmail({ to: adminEmail, kind: 'recovery', check: r.check, detail: 'check is passing again', durationMinutes: r.minutes }).catch(() => false);
      }
    }
    for (const checkName of newlyOpened) {
      await audit({ actorEmail: 'system-watch', action: 'monitor_incident_opened', target: checkName, detail: checks.find((c) => c.check === checkName)?.detail ?? '' }).catch(() => undefined);
    }

    const failing = checks.filter((c) => !c.ok).length;
    return Response.json({
      ok: failing === 0,
      time: now.toISOString(),
      checks,
      incidents: { newlyOpened, recovered },
      alerting: { email: Boolean(adminEmail && emailConfigured) },
    });
  } catch (e) {
    console.error('system-watch error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'System watch pass failed.' }, { status: 500 });
  }
}
