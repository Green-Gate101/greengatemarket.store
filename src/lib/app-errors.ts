import { createHash } from 'crypto';
import { db } from './db';

/**
 * App-error log for the in-app monitor (additive — nothing existing changes).
 *
 * Two feeds write here:
 *  - browsers: crashes and unhandled errors on buyers' and sellers' screens,
 *    posted to /api/monitor/errors (src/lib/error-reporter.ts)
 *  - the server: everything logged with console.error — every API route
 *    already logs its failures that way before answering 500, so capturing
 *    the log (src/instrumentation.ts) covers them all without touching a route
 *
 * One row per distinct error (source + page/route + message), counted each
 * time it repeats; the admin console's System monitor lists them. Emails,
 * long numbers and tokens are scrubbed out before anything is stored, rows
 * unseen for 30 days are dropped and the table never holds more than 1000.
 */

export type AppErrorSource = 'browser' | 'server';

const MAX_MESSAGE = 300;
const MAX_DETAIL = 1200;
const MAX_ROWS = 1000;
const KEEP_DAYS = 30;
/** Repeats of one error inside this window are added up and written together. */
const REPEAT_WINDOW_MS = 2000;

/** Removes anything personal or secret from error text before it is stored. */
export function scrubErrorText(text: string, max: number): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:sk|pk|rk|ghp|gho|vcp|whsec|re)_[A-Za-z0-9_]{6,}/g, '[secret]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[token]')
    .replace(/(bearer|basic|token|key|secret|password|passphrase)([=:\s"']+)[^\s"',;&]+/gi, '$1$2[hidden]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[token]')
    .replace(/\d{6,}/g, '[number]')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Page or route only — query strings can carry reset tokens and other secrets. */
function cleanPath(raw: string): string {
  return raw.split('?')[0].replace(/\\/g, '/').slice(0, 160);
}

const pending = new Map<string, { at: number; extra: number }>();

export async function recordAppError(input: { source: AppErrorSource; message: string; path?: string; detail?: string }): Promise<void> {
  const message = scrubErrorText(input.message || 'Unknown error', MAX_MESSAGE) || 'Unknown error';
  const path = cleanPath(input.path ?? '');
  const detail = scrubErrorText(input.detail ?? '', MAX_DETAIL);
  const fingerprint = createHash('sha256').update(`${input.source}|${path}|${message}`).digest('hex').slice(0, 40);

  // An error storm must not turn into a database storm: repeats within a
  // couple of seconds are counted here and written with the next one.
  const now = Date.now();
  const seen = pending.get(fingerprint);
  if (seen && now - seen.at < REPEAT_WINDOW_MS) {
    seen.extra += 1;
    return;
  }
  const times = 1 + (seen?.extra ?? 0);
  if (pending.size > 500) pending.clear();
  pending.set(fingerprint, { at: now, extra: 0 });

  const update = { count: { increment: times }, lastSeenAt: new Date(), ...(detail ? { detail } : {}) };
  try {
    const row = await db.appError.upsert({
      where: { fingerprint },
      create: { fingerprint, source: input.source, path, message, detail, count: times },
      update,
      select: { count: true },
    });
    if (row.count === times && Math.random() < 0.1) await pruneAppErrors();
  } catch {
    // Two servers creating the same new error at once: the loser adds to the winner's row.
    await db.appError.update({ where: { fingerprint }, data: update }).catch(() => undefined);
  }
}

async function pruneAppErrors(): Promise<void> {
  await db.appError.deleteMany({ where: { lastSeenAt: { lt: new Date(Date.now() - KEEP_DAYS * 86_400_000) } } });
  const total = await db.appError.count();
  if (total > MAX_ROWS) {
    const oldest = await db.appError.findMany({ orderBy: { lastSeenAt: 'asc' }, take: total - MAX_ROWS, select: { id: true } });
    await db.appError.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } });
  }
}

/** What the System monitor shows: how many kinds of error were seen lately, and the latest ones. */
export async function appErrorSummary() {
  const now = Date.now();
  const [lastHour, last24h, recent] = await Promise.all([
    db.appError.count({ where: { lastSeenAt: { gte: new Date(now - 3_600_000) } } }),
    db.appError.count({ where: { lastSeenAt: { gte: new Date(now - 86_400_000) } } }),
    db.appError.findMany({
      where: { lastSeenAt: { gte: new Date(now - 7 * 86_400_000) } },
      orderBy: { lastSeenAt: 'desc' },
      take: 25,
      select: { source: true, path: true, message: true, detail: true, count: true, firstSeenAt: true, lastSeenAt: true },
    }),
  ]);
  return { kindsLastHour: lastHour, kindsLast24h: last24h, recent };
}

// ---------------------------------------------------------------------------
// Server capture — installed once per server by src/instrumentation.ts
// ---------------------------------------------------------------------------

let installed = false;
let writing = 0;
/** The route being served — Next.js keeps it in its per-request store. */
let currentRoute: () => string = () => '';

function describe(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.name && arg.name !== 'Error' ? `${arg.name}: ${arg.message}` : arg.message;
  try {
    return JSON.stringify(arg)?.slice(0, 200) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/** The API route or page whose code logged the error, read from the call stack. */
function routeFromStack(stack: string): string {
  const m = stack.replace(/\\/g, '/').match(/\/app\/([^\s()]+?)\/(route|page)\.[jt]sx?/);
  if (!m) return '';
  return `/${m[1].split('/').filter((seg) => !/^\(.*\)$/.test(seg)).join('/')}`;
}

export async function installServerErrorCapture(): Promise<void> {
  if (installed) return;
  installed = true;
  try {
    const { workAsyncStorage } = await import('next/dist/server/app-render/work-async-storage.external.js');
    currentRoute = () => {
      try {
        return workAsyncStorage.getStore()?.route ?? '';
      } catch {
        return '';
      }
    };
  } catch {
    // A Next.js without this store: the call stack is the fallback below.
  }
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(...args);
    // Bounded: a flood of errors (or the database itself being down) can
    // never pile up unbounded writes.
    if (writing >= 20) return;
    try {
      const message = args.map(describe).join(' ').trim();
      if (!message) return;
      const err = args.find((a): a is Error => a instanceof Error);
      const path = currentRoute() || routeFromStack(err?.stack ?? '') || routeFromStack(new Error().stack ?? '');
      writing += 1;
      void recordAppError({ source: 'server', message, path, detail: (err?.stack ?? '').split('\n').slice(0, 6).join('\n') })
        .catch(() => undefined)
        .finally(() => { writing -= 1; });
    } catch {
      // logging must never throw
    }
  };
}
