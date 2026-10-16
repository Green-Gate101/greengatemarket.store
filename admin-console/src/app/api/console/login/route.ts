import { NextRequest, NextResponse } from 'next/server';

/**
 * Sign-in for the standalone admin console.
 *
 * The console never sees or stores passwords beyond this single request:
 * it performs the marketplace's standard NextAuth credentials dance
 * server-to-server, captures the resulting session cookie, and parks it in
 * an httpOnly cookie scoped to the console's own domain. Browser JavaScript
 * can never read it; every admin API call is made from the console's server.
 *
 * The marketplace app is NOT modified in any way for this to work.
 */

const MAIN = (process.env.MAIN_SITE_URL || 'https://www.greengatemarket.store').replace(/\/+$/, '');
const SESS_COOKIE = 'gg_admin_sess';
const SESS_MAX_AGE = 60 * 60 * 24 * 7; // one week; the marketplace still validates it

export async function POST(req: NextRequest) {
  let email = '';
  let password = '';
  try {
    const body = (await req.json()) as { email?: unknown; password?: unknown };
    email = typeof body.email === 'string' ? body.email.trim() : '';
    password = typeof body.password === 'string' ? body.password : '';
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 });
  }

  try {
    // 1. CSRF token from the marketplace (NextAuth requires the paired cookie)
    const csrfRes = await fetch(`${MAIN}/api/auth/csrf`, { cache: 'no-store' });
    if (!csrfRes.ok) {
      return NextResponse.json({ error: `Could not reach ${MAIN} (status ${csrfRes.status}).` }, { status: 502 });
    }
    const { csrfToken } = (await csrfRes.json()) as { csrfToken?: string };
    if (!csrfToken) {
      return NextResponse.json({ error: 'Marketplace did not return a CSRF token.' }, { status: 502 });
    }
    const csrfCookies = csrfRes.headers.getSetCookie().map((c) => c.split(';')[0]).filter(Boolean).join('; ');

    // 2. Credentials callback — same flow the marketplace's own sign-in uses
    const form = new URLSearchParams({ csrfToken, email, password, redirect: 'false', json: 'true' });
    const cb = await fetch(`${MAIN}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(csrfCookies ? { cookie: csrfCookies } : {}),
      },
      body: form.toString(),
      redirect: 'manual',
      cache: 'no-store',
    });

    // NextAuth v4 signals failed credentials in several shapes depending on
    // version/options: a 401 JSON {error:"CredentialsSignin"}, a 302 to the
    // error URL, or a 200 JSON {url:"…error=CredentialsSignin…"}. Detect all.
    const location = cb.headers.get('location') ?? '';
    let bodyUrl = '';
    let bodyError = '';
    try {
      const j = (await cb.json()) as { url?: string; error?: string };
      bodyUrl = typeof j?.url === 'string' ? j.url : '';
      bodyError = typeof j?.error === 'string' ? j.error : '';
    } catch { /* empty/HTML body on redirect — handled below */ }

    const credentialsFailed =
      bodyError === 'CredentialsSignin' ||
      /error=CredentialsSignin/.test(location) ||
      /error=CredentialsSignin/.test(bodyUrl);

    // Capture the marketplace session cookie (name varies: the secure
    // `__Secure-` prefixed variant in production, plain in http dev).
    const sessionCookie = cb.headers.getSetCookie()
      .map((c) => c.split(';')[0])
      .find((c) => /session-token=/i.test(c) && !/=$/.test(c));

    if (credentialsFailed || !cb.ok) {
      return NextResponse.json(
        { error: credentialsFailed ? 'Incorrect email or password.' : 'Sign-in failed. Check the email and password.' },
        { status: 401 },
      );
    }
    if (!sessionCookie) {
      return NextResponse.json({ error: 'Sign-in succeeded but no session was issued.' }, { status: 502 });
    }

    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESS_COOKIE, sessionCookie, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESS_MAX_AGE,
    });
    return res;
  } catch (e) {
    console.error('console login error:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not sign in to the marketplace. Try again.' }, { status: 502 });
  }
}
