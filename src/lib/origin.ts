/**
 * Trusted origin for links embedded in transactional emails.
 *
 * Email links are security-sensitive: a password-reset URL must point at THIS
 * deployment, never at an attacker-controlled host. The client-supplied
 * `Origin` header is therefore only honoured when it matches the deployment's
 * own host; otherwise the forwarded host of the request itself is used.
 * An explicit NEXTAUTH_URL always wins (server-configured, trusted).
 */
export function emailLinkOrigin(req: Request): string {
  const configured = process.env.NEXTAUTH_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  const host = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || req.headers.get('host') || '';
  if (!host) return '';
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  const ownOrigin = `${proto}://${host}`;

  const reqOrigin = req.headers.get('origin')?.trim();
  if (reqOrigin) {
    try {
      if (new URL(reqOrigin).host === host) return reqOrigin.replace(/\/+$/, '');
    } catch {
      // malformed Origin header — ignore it
    }
  }
  return ownOrigin;
}
