import { NextRequest, NextResponse } from 'next/server';

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
    });
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (e) {
    console.error('console data error:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not reach the marketplace API.' }, { status: 502 });
  }
}
