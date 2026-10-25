import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { algoliaConfigured } from '@/lib/algolia';

export const dynamic = 'force-dynamic';

/**
 * Safe integration health check (spec #84): reports which subsystems are
 * configured and reachable without ever exposing a credential value.
 */
export async function GET() {
  const checks: { service: string; ok: boolean; detail: string }[] = [];

  // Database
  let dbOk = true;
  try {
    await bootstrap();
    await db.$queryRaw`SELECT 1`;
  } catch {
    dbOk = false;
  }
  checks.push({ service: 'database', ok: dbOk, detail: dbOk ? 'connected' : 'unavailable' });

  // Search
  checks.push({ service: 'search (Algolia)', ok: algoliaConfigured, detail: algoliaConfigured ? 'configured' : 'fallback to database search' });

  // Email
  checks.push({ service: 'email (Resend)', ok: Boolean(process.env.RESEND_API_KEY), detail: process.env.RESEND_API_KEY ? 'configured' : 'not configured' });

  // Delivery — live city-pair quotes run on TCG's public prepaid rate card; no
  // credential is required. A merchant Access Token (if configured) switches to
  // the merchant's negotiated rates; the flat-rate table backs everything up.
  checks.push({ service: 'delivery (The Courier Guy)', ok: true, detail: process.env.COURIER_GUY_API_KEY ? 'live rates (merchant token configured), flat-rate fallback' : 'live rates (public prepaid rate card), flat-rate fallback' });

  // Payments
  checks.push({ service: 'payments (seller processors)', ok: true, detail: 'buyers pay through each seller’s PayFast, Ozow or Yoco account — no bank transfers' });

  // Google sign-in
  checks.push({
    service: 'google sign-in',
    ok: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    detail: process.env.GOOGLE_CLIENT_ID ? 'configured' : 'requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET',
  });

  const status = checks.every((c) => c.ok) ? 'ok' : 'degraded';
  return Response.json({ status, checks, time: new Date().toISOString() });
}
