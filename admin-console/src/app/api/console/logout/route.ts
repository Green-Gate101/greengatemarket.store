import { NextRequest, NextResponse } from 'next/server';
import { isCrossOriginRequest } from '../same-origin';

/** Clears the console session cookie. The marketplace session itself is
 *  untouched (the owner may still be signed in on the main site). */
export async function POST(req: NextRequest) {
  if (isCrossOriginRequest(req)) return NextResponse.json({ error: 'Cross-site request refused.' }, { status: 403 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set('gg_admin_sess', '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
