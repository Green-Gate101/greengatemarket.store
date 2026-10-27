import { db } from '@/lib/db';
import { addToCounter } from '@/lib/batched-counter';

/**
 * Daily API usage counters for the admin console (Insights → API usage).
 *
 * Each outbound third-party call increments a per-service, per-UTC-day row.
 * Everything is fire-and-forget: telemetry must NEVER break or slow down a
 * customer request, so every failure is swallowed. Counters measure real
 * usage of paid integrations (emails sent, courier quotes, geocode calls,
 * search queries) so the admin knows when to move up a provider's plan.
 */
export function trackApiUsage(service: 'resend' | 'courier_guy' | 'geocode' | 'algolia' | 'yoco' | 'remove_bg'): void {
  const day = new Date().toISOString().slice(0, 10);
  // One row per service per day takes every call's +1 — added up in memory
  // and written every few seconds so busy searches never queue on that row.
  addToCounter(`usage:${service}:${day}`, (n) =>
    db.apiUsage.upsert({
      where: { service_day: { service, day } },
      create: { service, day, count: n },
      update: { count: { increment: n } },
    }),
  );
}
