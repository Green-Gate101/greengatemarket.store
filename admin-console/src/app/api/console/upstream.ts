import { NextResponse } from 'next/server';

/**
 * Shared plumbing for the console's calls to the marketplace.
 *
 * Every upstream call has a hard ceiling: a slow or hung marketplace must
 * never hang the console (the System monitor polls every second, so an
 * unbounded call would pile up requests exactly when the site is struggling).
 */
export const UPSTREAM_TIMEOUT_MS = { monitor: 10_000, data: 25_000, action: 25_000, login: 15_000 } as const;

/**
 * Relay the marketplace's answer as JSON. A host error page (HTML 502/504
 * while the marketplace restarts or cold-starts) becomes a readable JSON
 * error instead of a parse failure in the browser.
 */
export async function relayJson(res: Response): Promise<NextResponse> {
  const text = await res.text();
  if (!/json/i.test(res.headers.get('content-type') ?? '')) {
    return NextResponse.json(
      { error: `The marketplace answered with HTTP ${res.status} — it may be restarting; try again shortly.` },
      { status: res.ok ? 502 : res.status, headers: { 'cache-control': 'no-store' } },
    );
  }
  return new NextResponse(text, {
    status: res.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** 504 for a timeout, 502 for anything else that kept us from the marketplace. */
export function upstreamFailure(e: unknown, label: string): NextResponse {
  const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
  console.error(`console ${label} error:`, e instanceof Error ? e.message : e);
  return NextResponse.json(
    { error: timedOut ? 'The marketplace took too long to answer — try again in a moment.' : 'Could not reach the marketplace API.' },
    { status: timedOut ? 504 : 502 },
  );
}
