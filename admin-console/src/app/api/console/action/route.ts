import { NextRequest, NextResponse } from 'next/server';
import { isCrossOriginRequest } from '../same-origin';

/**
 * Proxies POST {MAIN}/api/admin — moderation actions
 * (moderate_product, store_status, user_ban, confirm_payment,
 * create_category, delete_order, delete_user). The marketplace enforces
 * role, rate limits and audit logging; the console only forwards.
 */

const MAIN = (process.env.MAIN_SITE_URL || 'https://greengatemarket.store').replace(/\/+$/, '');

export async function POST(req: NextRequest) {
  if (isCrossOriginRequest(req)) return NextResponse.json({ error: 'Cross-site request refused.' }, { status: 403 });
  const sess = req.cookies.get('gg_admin_sess')?.value;
  if (!sess) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  // Sanity check: only forward well-formed action envelopes.
  const action = (body as { action?: unknown })?.action;
  const targetId = (body as { targetId?: unknown })?.targetId;
  if (typeof action !== 'string' || !/^[a-z_]{3,40}$/.test(action) || typeof targetId !== 'string' || targetId.length > 64) {
    return NextResponse.json({ error: 'Malformed action.' }, { status: 400 });
  }

  try {
    const res = await fetch(`${MAIN}/api/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sess },
      body: JSON.stringify(body),
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
    console.error('console action error:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not reach the marketplace API.' }, { status: 502 });
  }
}
