import type { NextRequest } from 'next/server';

/**
 * Cross-site request guard for the console's state-changing routes.
 *
 * The console cookie is SameSite=Lax, but greengatemarket.store and
 * admin.greengatemarket.store are the SAME site — so a script running on
 * the storefront (or any other subdomain) would still get the admin cookie
 * attached to a forged POST. Only requests made by the console's own pages
 * are accepted: browsers mark them `Sec-Fetch-Site: same-origin` and send a
 * matching `Origin`. Non-browser callers (no such headers) are unaffected —
 * they hold no admin cookie to abuse.
 */
export function isCrossOriginRequest(req: NextRequest): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.get('origin');
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  const hosts = [req.headers.get('x-forwarded-host'), req.headers.get('host'), req.nextUrl.host]
    .flatMap((h) => (h ? h.split(',').map((x) => x.trim()) : []));
  return !hosts.includes(originHost);
}
