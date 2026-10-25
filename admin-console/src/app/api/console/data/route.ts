import { NextRequest, NextResponse } from 'next/server';
import { relayJson, upstreamFailure, UPSTREAM_TIMEOUT_MS } from '../upstream';

/**
 * Proxies GET {MAIN}/api/admin — the full live dashboard payload
 * (stats, stores, orders, users, insights, applications, audit log).
 * The marketplace session cookie is attached server-side only.
 */

const MAIN = (process.env.MAIN_SITE_URL || 'https://greengatemarket.store').replace(/\/+$/, '');

export async function GET(req: NextRequest) {
  const sess = req.cookies.get('gg_admin_sess')?.value;
  if (!sess) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const res = await fetch(`${MAIN}/api/admin`, {
      headers: { cookie: sess },
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS.data),
    });
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    return await relayJson(res);
  } catch (e) {
    return upstreamFailure(e, 'data');
  }
}
