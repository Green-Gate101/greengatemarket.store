import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { algoliaConfigured } from '@/lib/algolia';
import { subscriptionPaymentsStatus } from '@/lib/subscription';
import { lookup as dnsLookup } from 'dns';

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
  // The API host is probed at the DNS level (cheap, no credentials, no API call)
  // so the detail tells the truth when The Courier Guy itself is unreachable —
  // quoting then quietly rides the flat-rate fallback until it returns.
  const tcgReachable = await Promise.race([
    new Promise<boolean>((resolve) => {
      try {
        dnsLookup('api.portal.thecourierguy.co.za', (err) => resolve(!err));
      } catch {
        resolve(false);
      }
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
  ]).catch(() => false);
  const tcgDetail = !tcgReachable
    ? 'The Courier Guy API unreachable right now — quoting on the flat-rate fallback until it returns'
    : process.env.COURIER_GUY_API_KEY
      ? 'live rates (merchant token configured), flat-rate fallback'
      : 'live rates (public prepaid rate card), flat-rate fallback';
  checks.push({ service: 'delivery (The Courier Guy)', ok: true, detail: tcgDetail });

  // Product photo backgrounds — the built-in white cut always runs; remove.bg
  // (when its key is set) whitens busy photos the built-in cut declines.
  checks.push({ service: 'photo backgrounds', ok: true, detail: process.env.REMOVE_BG_API_KEY ? 'built-in white cut + remove.bg for busy photos' : 'built-in white cut only (busy photos keep their background)' });

  // Payments
  checks.push({ service: 'payments (seller processors)', ok: true, detail: 'buyers pay through each seller’s PayFast, Ozow or Yoco account — no bank transfers' });

  // Seller subscriptions — Green Gate's own Yoco account (key set, live, accepted by Yoco).
  const subscriptions = await subscriptionPaymentsStatus().catch(() => ({ ok: false, detail: 'could not be checked' }));
  checks.push({ service: 'seller subscriptions (Yoco)', ok: subscriptions.ok, detail: subscriptions.detail });

  // Google sign-in
  checks.push({
    service: 'google sign-in',
    ok: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    detail: process.env.GOOGLE_CLIENT_ID ? 'configured' : 'requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET',
  });

  const status = checks.every((c) => c.ok) ? 'ok' : 'degraded';
  return Response.json({ status, checks, time: new Date().toISOString() });
}
