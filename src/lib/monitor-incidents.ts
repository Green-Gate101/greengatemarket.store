import { db } from '@/lib/db';
import { audit } from '@/lib/audit';
import { emailConfigured, sendSystemAlertEmail } from '@/lib/email';

/**
 * Shared incident state machine for the always-on monitor (additive).
 *
 * Called from two places:
 *  - /api/cron/system-watch (Vercel Cron — background watch; on the Hobby
 *    plan it runs once per day, an external pinger can hit it every minute)
 *  - /api/monitor (the admin console's System monitor tab polls it every
 *    second while open — so per-second incident tracking is live whenever a
 *    human is watching)
 *
 * One row per failing check: opened on the first failure, incremented while
 * it persists, resolved automatically on recovery. Alerts fire exactly ONCE
 * per episode (open + close) so an outage can never spam the admin inbox.
 * Detail strings never contain credential values.
 */

export interface WatchCheck {
  check: string;
  ok: boolean;
  detail: string;
}

export async function recordMonitorIncidents(checks: WatchCheck[]): Promise<{
  newlyOpened: string[];
  recovered: { check: string; minutes: number }[];
}> {
  const newlyOpened: string[] = [];
  const recovered: { check: string; minutes: number }[] = [];
  const now = new Date();

  // Only touch incident rows when the database itself answered above.
  const dbOk = checks.find((c) => c.check === 'database')?.ok;
  if (!dbOk) return { newlyOpened, recovered };

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

  // Alert once per episode (email + audit).
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

  return { newlyOpened, recovered };
}
