/**
 * In-process sliding-window rate limiter.
 *
 * Suitable for a single application instance; when scaling horizontally move
 * this behind the shared Redis/Upstash instance (same interface).
 */

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    bucket.hits = bucket.hits.filter((t) => now - t < 15 * 60_000);
    if (bucket.hits.length === 0) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * @param key    unique identifier, e.g. "login:1.2.3.4" or "product-create:user_123"
 * @param limit  max requests inside the window
 * @param windowMs window length in milliseconds
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
  if (bucket.hits.length >= limit) {
    buckets.set(key, bucket);
    const retryAfterMs = windowMs - (now - bucket.hits[0]);
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  bucket.hits.push(now);
  buckets.set(key, bucket);
  return { allowed: true, remaining: limit - bucket.hits.length, retryAfterSeconds: 0 };
}

/**
 * Shared (cross-instance) limiter for the security-sensitive doors — sign-in,
 * registration, password reset, checkout, payments, admin and seller writes.
 * The in-process limiter above is per server instance, so on Vercel an
 * attacker spread across instances got N× the limit; this one counts in the
 * project's Upstash Redis (KV_REST_API_URL / KV_REST_API_TOKEN, REST API),
 * fixed window per key, keys SHA-256-hashed (no emails/IPs stored).
 *
 * The local limiter still runs first (a cheap per-instance ceiling). Without
 * Redis configured, or if Redis is slow/unreachable (800ms), it falls back to
 * the local result — a Redis hiccup never blocks or slows the store.
 */
export async function rateLimitShared(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const local = rateLimit(key, limit, windowMs);
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!local.allowed || !url || !token) return local;
  try {
    const { createHash } = await import('crypto');
    const k = `gg:rl:${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
    const call = (commands: (string | number)[][]) =>
      fetch(`${url.replace(/\/+$/, '')}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(commands),
        signal: AbortSignal.timeout(800),
        cache: 'no-store',
      });
    // Start the window if absent, count this hit, read the remaining TTL.
    const res = await call([['SET', k, '0', 'PX', String(windowMs), 'NX'], ['INCR', k], ['PTTL', k]]);
    if (!res.ok) return local;
    const out = (await res.json()) as { result?: unknown }[];
    const count = Number(out?.[1]?.result);
    let ttl = Number(out?.[2]?.result);
    if (!Number.isFinite(count)) return local;
    if (!(ttl > 0)) {
      // Key lost its expiry (expired between SET and INCR) — never leave a
      // counter that would block forever.
      await call([['PEXPIRE', k, String(windowMs)]]).catch(() => undefined);
      ttl = windowMs;
    }
    if (count > limit) {
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)) };
    }
    return { allowed: true, remaining: Math.max(0, limit - count), retryAfterSeconds: 0 };
  } catch {
    return local;
  }
}

/** Best-effort client IP from proxy headers. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

/** 429 response with Retry-After header. */
export function tooManyRequests(result: RateLimitResult): Response {
  return Response.json(
    { error: `Too many requests. Please try again in ${result.retryAfterSeconds}s.` },
    { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds) } },
  );
}
