import { db } from '@/lib/db';

/**
 * Security audit trail. Never exposed publicly — admin-only via the
 * authenticated admin API. Never log credentials, tokens or secrets.
 */
export async function audit(entry: {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  target?: string | null;
  detail?: string | null;
  ip?: string | null;
}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        actorEmail: entry.actorEmail ?? null,
        action: entry.action,
        target: entry.target ?? null,
        detail: entry.detail ?? null,
        ip: entry.ip ?? null,
      },
    });
  } catch (e) {
    // Auditing must never break the primary flow, but failures are logged.
    console.error('audit write failed:', e instanceof Error ? e.message : e);
  }
}
