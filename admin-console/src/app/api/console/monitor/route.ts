import { NextRequest, NextResponse } from 'next/server';
import { relayJson, upstreamFailure, UPSTREAM_TIMEOUT_MS } from '../upstream';

/**
 * Proxies GET {MAIN}/api/monitor — the live operations snapshot (service
 * checks, system-watch incidents, payment vitals, queues). The marketplace
 * session cookie is attached server-side only; the main site re-enforces the
 * ADMIN role on every call, so this proxy adds no authority of its own.
 */

const MAIN = (process.env.MAIN_SITE_URL || 'https://greengatemarket.store').replace(/\/+$/, '');

export async function GET(req: NextRequest) {
  const sess = req.cookies.get('gg_admin_sess')?.value;
  if (!sess) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const res = await fetch(`${MAIN}/api/monitor`, {
      headers: { cookie: sess },
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS.monitor),
    });
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    return await relayJson(res);
  } catch (e) {
    return upstreamFailure(e, 'monitor');
  }
}
