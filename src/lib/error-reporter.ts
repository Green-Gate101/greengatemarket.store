/**
 * Browser error reporting for the in-app monitor (client only).
 *
 * Crashes and unhandled errors on a buyer's or seller's screen are sent to
 * /api/monitor/errors so they show up in the admin console's System monitor
 * instead of disappearing in someone's phone. At most 5 different errors per
 * page load; dropped connections, browser extensions and other noise that is
 * not the app's fault are skipped. Nothing about the person is sent — only
 * the error, its first stack lines and the page it happened on.
 */

const IGNORE = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i, // another site's script — the browser hides the details
  /due to access control checks/i, // Safari: a request cancelled by navigating away
  /AbortError|signal is aborted|The user aborted/i,
  /Failed to fetch|Load failed|NetworkError|Network request failed|network error/i,
  /chrome-extension:|moz-extension:|safari-(web-)?extension:/i,
];

const sent = new Set<string>();
let budget = 5;

export function reportClientError(error: unknown, kind: string): void {
  try {
    const err = error instanceof Error ? error : null;
    const message = (err ? `${err.name && err.name !== 'Error' ? `${err.name}: ` : ''}${err.message}` : String(error ?? '')).trim();
    const stack = err?.stack ?? '';
    if (!message || IGNORE.some((re) => re.test(message) || re.test(stack))) return;
    const key = `${kind}|${message}`;
    if (sent.has(key) || budget <= 0) return;
    sent.add(key);
    budget -= 1;
    const body = JSON.stringify({
      kind,
      message: message.slice(0, 500),
      stack: stack.split('\n').slice(0, 8).join('\n').slice(0, 1500),
      path: `${location.pathname}${location.hash}`.split('?')[0].slice(0, 160),
    });
    // text/plain: older browsers refuse sendBeacon with a JSON content type.
    if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon('/api/monitor/errors', new Blob([body], { type: 'text/plain' }))) return;
    void fetch('/api/monitor/errors', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, keepalive: true }).catch(() => undefined);
  } catch {
    // reporting must never cause an error of its own
  }
}

let installed = false;

export function installClientErrorReporter(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => reportClientError(e.error ?? e.message, 'error'));
  window.addEventListener('unhandledrejection', (e) => reportClientError(e.reason, 'unhandled promise'));
}
