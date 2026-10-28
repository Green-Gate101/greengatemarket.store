import { NextRequest, NextResponse } from 'next/server';
import { isCrossOriginRequest } from '../same-origin';
import { UPSTREAM_TIMEOUT_MS } from '../upstream';

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

const MAIN = (process.env.MAIN_SITE_URL || 'https://greengatemarket.store').replace(/\/+$/, '');
const SESS_COOKIE = 'gg_admin_sess';
const SESS_MAX_AGE = 60 * 60 * 24 * 7; // one week; the marketplace still validates it

// In-memory sliding-window rate limit: the console relays password guesses to
// the marketplace's credentials flow, so it is a second brute-force door on
// admin credentials and must be throttled here too. Single-instance limiter —
// the same trade-off the marketplace's own rate limiting makes.
const attempts = new Map<string, number[]>();
const WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 10;
function clientKey(req: NextRequest): string {
  // Take the RIGHTMOST XFF entry: on hosts where the proxy APPENDS client-supplied
  // values, the leftmost entry is attacker-controlled and rotating it would reset
  // the bucket every request. Vercel overwrites XFF itself, so leftmost and
  // rightmost are the same real client IP there — this only hardens other hosts.
  const xff = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - 1] || req.headers.get('x-real-ip') || 'unknown';
}
function overLimit(key: string): boolean {
  const now = Date.now();
  const list = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  attempts.set(key, list);
  if (attempts.size > 1000) {
    for (const [k, v] of attempts) if (v.every((t) => now - t >= WINDOW_MS)) attempts.delete(k);
    // Hard cap: a flood of rotated keys must never grow the map without
    // bound — drop the oldest buckets (insertion order = age) past 2000.
    while (attempts.size > 2000) {
      const oldest = attempts.keys().next().value;
      if (oldest === undefined) break;
      attempts.delete(oldest);
    }
  }
  return list.length > MAX_ATTEMPTS;
}

export async function POST(req: NextRequest) {
  // Login CSRF guard: a foreign page must not be able to plant its own
  // session in the admin's browser.
  if (isCrossOriginRequest(req)) return NextResponse.json({ error: 'Cross-site request refused.' }, { status: 403 });
  if (overLimit(clientKey(req))) {
    return NextResponse.json({ error: 'Too many sign-in attempts. Please wait a few minutes and try again.' }, { status: 429 });
  }
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
    const csrfRes = await fetch(`${MAIN}/api/auth/csrf`, { cache: 'no-store', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS.login) });
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
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS.login),
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
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return NextResponse.json(
      { error: timedOut ? 'The marketplace took too long to answer — try again in a moment.' : 'Could not sign in to the marketplace. Try again.' },
      { status: timedOut ? 504 : 502 },
    );
  }
}
