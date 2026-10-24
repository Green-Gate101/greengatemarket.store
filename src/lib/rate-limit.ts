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
 * Redis configured, or if Redis is slow/unreachable (1.5 s), it falls back to
 * the local result — a Redis hiccup never blocks or slows the store.
 */
/** The Upstash REST endpoint + token, or null (shared limiting off). */
function sharedStore(): { url: string; token: string } | null {
  const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

function redisPipeline(store: { url: string; token: string }, commands: (string | number)[][], timeoutMs: number) {
  return fetch(`${store.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${store.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
}

// Fallbacks are logged (at most once a minute per instance) so a silently
// degraded shared limiter shows up in the logs and the system monitor.
let lastSharedWarn = 0;
let lastSharedError: string | null = null;
function noteSharedFailure(reason: string) {
  lastSharedError = reason;
  const now = Date.now();
  if (now - lastSharedWarn > 60_000) {
    lastSharedWarn = now;
    console.warn(`shared rate limiter unavailable — using the per-instance limiter: ${reason}`);
  }
}

/** Live check for the system monitor: is the shared limiter really working? */
export async function sharedLimiterStatus(): Promise<{ configured: boolean; ok: boolean; detail: string }> {
  const store = sharedStore();
  if (!store) return { configured: false, ok: false, detail: 'not configured (KV_REST_API_URL / KV_REST_API_TOKEN) — limits are per instance only' };
  const t0 = Date.now();
  try {
    const res = await redisPipeline(store, [['PING']], 3000);
    const body = await res.text();
    if (!res.ok) return { configured: true, ok: false, detail: `Redis answered HTTP ${res.status}: ${body.slice(0, 120)}` };
    const pong = /PONG/.test(body);
    return { configured: true, ok: pong, detail: pong ? `Redis reachable (${Date.now() - t0} ms)` : `unexpected Redis reply: ${body.slice(0, 120)}` };
  } catch (e) {
    return { configured: true, ok: false, detail: `Redis unreachable: ${e instanceof Error ? e.message : 'error'}${lastSharedError ? ` · last limiter error: ${lastSharedError}` : ''}` };
  }
}

export async function rateLimitShared(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const local = rateLimit(key, limit, windowMs);
  const store = sharedStore();
  if (!local.allowed || !store) return local;
  try {
    const { createHash } = await import('crypto');
    const k = `gg:rl:${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
    const call = (commands: (string | number)[][]) => redisPipeline(store, commands, 1500);
    // Start the window if absent, count this hit, read the remaining TTL.
    const res = await call([['SET', k, '0', 'PX', String(windowMs), 'NX'], ['INCR', k], ['PTTL', k]]);
    if (!res.ok) {
      noteSharedFailure(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
      return local;
    }
    const out = (await res.json()) as { result?: unknown; error?: string }[];
    const count = Number(out?.[1]?.result);
    let ttl = Number(out?.[2]?.result);
    if (!Number.isFinite(count)) {
      noteSharedFailure(`unexpected reply ${JSON.stringify(out).slice(0, 120)}`);
      return local;
    }
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
  } catch (e) {
    noteSharedFailure(e instanceof Error ? e.message : 'error');
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
