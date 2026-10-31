import { NextRequest } from 'next/server';
import { bootstrap } from '@/lib/bootstrap';
import { recordAppError } from '@/lib/app-errors';
import { rateLimitShared, clientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Browser error reports for the in-app monitor (src/lib/error-reporter.ts).
 * Open to every visitor — crashes happen to signed-out buyers too — so it is
 * bounded: 30 reports per hour per address, 4 KB per report, same-site pages
 * only, and the text is scrubbed before it is stored (src/lib/app-errors.ts).
 * Always answers 204 so a report can never surface as a second error.
 */
export async function POST(req: NextRequest) {
  const done = () => new Response(null, { status: 204 });
  try {
    const origin = req.headers.get('origin');
    const host = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || req.headers.get('host') || '';
    if (origin) {
      try {
        if (new URL(origin).host !== host) return done();
      } catch {
        return done();
      }
    }
    if (Number(req.headers.get('content-length') ?? 0) > 8_000) return done();
    const rl = await rateLimitShared(`client-error:${clientIp(req)}`, 30, 3600_000);
    if (!rl.allowed) return done();

    let body: { kind?: unknown; message?: unknown; stack?: unknown; path?: unknown };
    try {
      body = JSON.parse((await req.text()).slice(0, 4_000));
    } catch {
      return done();
    }
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return done();
    const kind = typeof body.kind === 'string' ? body.kind.slice(0, 40) : 'error';
    await bootstrap();
    await recordAppError({
      source: 'browser',
      message: kind === 'error' ? message : `${kind}: ${message}`,
      path: typeof body.path === 'string' ? body.path : '',
      detail: typeof body.stack === 'string' ? body.stack : '',
    });
  } catch {
    // never let a report fail loudly
  }
  return done();
}
