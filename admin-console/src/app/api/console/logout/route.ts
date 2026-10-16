import { NextResponse } from 'next/server';

/** Clears the console session cookie. The marketplace session itself is
 *  untouched (the owner may still be signed in on the main site). */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set('gg_admin_sess', '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
