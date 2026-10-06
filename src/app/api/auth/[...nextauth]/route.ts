import NextAuth from 'next-auth';
import { authOptions } from '@/lib/auth';

const handler = NextAuth(authOptions);

/**
 * NextAuth origin resolution (AUTH_TRUST_HOST mode):
 *
 * next-auth v4 derives the request origin from `x-forwarded-host` +
 * `x-forwarded-proto`. Through the preview gateway and on Vercel those
 * headers are always present, but a DIRECT request to the dev server
 * (http://localhost:3000) carries neither — next-auth would assume https
 * and the browser's http callback URL would fail origin validation
 * (credentials sign-in fails with 401).
 *
 * Fill the missing protocol from the request URL itself before NextAuth
 * sees the request. Gateway/Vercel requests already carry the header and
 * pass through untouched.
 */
function withForwardedProto(req: Request): Request {
  if (req.headers.has('x-forwarded-proto')) return req;
  const headers = new Headers(req.headers);
  headers.set('x-forwarded-proto', new URL(req.url).protocol.replace(':', ''));
  return new Request(req.url, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
    // @ts-expect-error -- duplex is required by undici for streaming request bodies
    duplex: 'half',
  });
}

export async function GET(req: Request, ctx: { params: Promise<Record<string, string | string[]>> }) {
  return handler(withForwardedProto(req), ctx);
}

export async function POST(req: Request, ctx: { params: Promise<Record<string, string | string[]>> }) {
  return handler(withForwardedProto(req), ctx);
}
