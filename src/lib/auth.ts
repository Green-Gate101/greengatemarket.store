import type { NextAuthOptions } from 'next-auth';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { headers, cookies } from 'next/headers';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import { getServerSession } from 'next-auth';
import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { verifyPassword } from '@/lib/password';
import { rateLimit } from '@/lib/rate-limit';
import type { Role } from '@/lib/types';

/**
 * Authentication: NextAuth v4 with JWT sessions (httpOnly, signed cookies).
 *
 * - Credentials: email + scrypt-hashed password, verified server-side.
 * - Google: real OAuth flow, activated the moment GOOGLE_CLIENT_ID and
 *   GOOGLE_CLIENT_SECRET are present in the environment. Without them the
 *   frontend reports the missing configuration honestly (no fake success).
 * - Roles (BUYER/SELLER/ADMIN) live in the signed token and are re-checked
 *   against the database on privileged calls — the browser is never trusted.
 */

export const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt', maxAge: 60 * 60 * 24 * 7 },
  // A stable secret is required for JWT sessions to decrypt identically in the
  // auth route and in getServerSession. When NEXTAUTH_SECRET is not configured
  // (local development), next-auth's fallback derivation differs between those
  // two paths, breaking every authenticated call — so pin a dev-only value.
  // The deploy pipeline always sets NEXTAUTH_SECRET in production.
  secret: process.env.NEXTAUTH_SECRET ?? 'greengate-local-dev-secret-rotate-me',
  pages: { signIn: '/', error: '/' },
  providers: [
    Credentials({
      name: 'Email & password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, req) {
        // Serverless instances boot with an empty ephemeral database — the
        // credentials flow may be the FIRST request an instance ever serves,
        // so the schema + administrator account must exist before the lookup.
        // Idempotent; no-op on warm instances (cached promise).
        await bootstrap();
        const email = credentials?.email?.trim().toLowerCase();
        const password = credentials?.password ?? '';
        if (!email || !password) return null;

        // Brute-force door: the credentials endpoint is the one auth surface
        // with no limiter of its own (register/reset/verify have theirs).
        // 10 attempts per 15 minutes per email+IP — a locked-out attacker
        // sees exactly the generic failure a wrong password produces, so
        // account existence is never probed through sign-in.
        const fwdHeader = req?.headers?.['x-forwarded-for'];
        const ip = (Array.isArray(fwdHeader) ? fwdHeader[0] : fwdHeader)?.split(',')[0]?.trim()
          || (req?.headers?.['x-real-ip'] as string | undefined)
          || 'unknown';
        const rl = rateLimit(`login:${email}:${ip}`, 10, 15 * 60_000);
        if (!rl.allowed) return null;

        const user = await db.user.findUnique({ where: { email } });
        if (!user || !user.passwordHash) return null;
        // Banned accounts are locked out entirely — same generic response as a
        // wrong password so ban status is never probed through sign-in.
        if (user.banned) return null;
        if (!verifyPassword(password, user.passwordHash)) return null;
        return { id: user.id, email: user.email, name: user.name, image: user.image };
      },
    }),
    ...(googleEnabled
      ? [
          Google({
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
            allowDangerousEmailAccountLinking: true,
          }),
        ]
      : []),
  ],
  callbacks: {
    async signIn({ account, profile }) {
      // Google accounts are linked to existing users BY EMAIL (jwt below), so
      // the address must be one Google actually verified — otherwise an
      // unverified Google identity could take over the matching account,
      // administrators included. Banned accounts stay locked out here too.
      if (account?.provider === 'google') {
        const p = profile as { email?: string; email_verified?: boolean | string } | undefined;
        if (!p?.email || !(p.email_verified === true || p.email_verified === 'true')) return false;
        const existing = await db.user.findUnique({ where: { email: p.email.toLowerCase() }, select: { banned: true } });
        if (existing?.banned) return false;
      }
      return true;
    },
    async jwt({ token, user, profile }) {
      // NextAuth passes `user` on EVERY first sign-in, OAuth included — only
      // credentials sign-ins arrive without a provider profile, so OAuth must
      // reach the provisioning branch below (new Google users get an account).
      if (user && !profile?.email) {
        // Credentials sign-in
        const dbUser = await db.user.findUnique({ where: { email: user.email! } });
        if (dbUser) {
          token.uid = dbUser.id;
          token.role = dbUser.role as Role;
          token.picture = dbUser.image ?? token.picture;
        }
      } else if (profile?.email) {
        // OAuth sign-in: link or provision the account server-side
        const email = profile.email.toLowerCase();
        const dbUser = await db.user.upsert({
          where: { email },
          update: {},
          create: {
            email,
            name: profile.name ?? null,
            image: (profile as { picture?: string }).picture ?? null,
            emailVerified: new Date(),
          },
        });
        token.uid = dbUser.id;
        token.role = dbUser.role as Role;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.uid as string) ?? '';
        session.user.role = (token.role as Role) ?? 'BUYER';
      }
      return session;
    },
  },
};

export interface ServerSession {
  user: { id: string; email: string; name: string | null; role: Role };
}

/** Returns the authenticated session or null. Role freshness is re-verified from the DB for privileged use. */
export async function getSession(): Promise<ServerSession | null> {
  const session = await getServerSessionWithProto();
  if (!session?.user?.id) return null;
  return {
    user: {
      id: session.user.id,
      email: session.user.email ?? '',
      name: session.user.name ?? null,
      role: (session.user.role as Role) ?? 'BUYER',
    },
  };
}

/**
 * next-auth's origin detection (AUTH_TRUST_HOST mode) assumes https when
 * `x-forwarded-proto` is absent — direct http access to the dev server — and
 * then reads the `__Secure-` cookie name, which the sign-in flow never set on
 * an http origin (the auth route injects the protocol itself, see
 * app/api/auth/[...nextauth]/route.ts). Mirror that shim for every server-side
 * session read so all authenticated routes agree with the cookie that was
 * actually set. Gateway and Vercel requests always carry the header and pass
 * through untouched.
 */
async function getServerSessionWithProto() {
  const h = await headers();
  const headerEntries = Object.fromEntries(h.entries());
  if (!headerEntries['x-forwarded-proto']) {
    headerEntries['x-forwarded-proto'] = 'http';
  }
  const jar = await cookies();
  const fakeReq = {
    headers: headerEntries,
    cookies: Object.fromEntries(jar.getAll().map((c) => [c.name, c.value])),
  } as unknown as IncomingMessage & { cookies: Record<string, string> };
  const fakeRes = { getHeader() {}, setCookie() {}, setHeader() {} } as unknown as ServerResponse<IncomingMessage>;
  return getServerSession(fakeReq, fakeRes, authOptions);
}

export async function requireUser(): Promise<ServerSession> {
  const session = await getSession();
  if (!session) throw new AuthError('Sign in to continue', 401);
  // Ban enforcement covers live sessions too — a banned account cannot act
  // even while its (stateless) session token has time left.
  const dbUser = await db.user.findUnique({ where: { id: session.user.id }, select: { banned: true } });
  if (dbUser?.banned) throw new AuthError('This account has been suspended', 403);
  return session;
}

export async function requireRole(...roles: Role[]): Promise<ServerSession> {
  const session = await requireUser();
  // Re-verify role from the database — the token is not authoritative.
  const dbUser = await db.user.findUnique({ where: { id: session.user.id }, select: { role: true, banned: true } });
  if (dbUser?.banned) throw new AuthError('This account has been suspended', 403);
  const role = (dbUser?.role as Role | undefined) ?? session.user.role;
  if (!roles.includes(role)) throw new AuthError('You do not have permission to perform this action', 403);
  return { ...session, user: { ...session.user, role } };
}

/**
 * Seller-store gate with legacy self-heal — the same heal PATCH /api/sellers
 * already applies to payment settings, now covering EVERY store operation.
 * Behaves exactly like requireRole('SELLER', 'ADMIN') except for one legacy
 * case: an account whose database role is still BUYER while it OWNS a store
 * (rows that predate the role-upgrade-on-application) is upgraded to SELLER
 * and allowed through, so an existing seller can never be locked out of
 * their own listing, editing, removal, orders or analytics by a stale role.
 * Everyone else sees exactly what requireRole returned before.
 */
export async function requireStoreSeller(): Promise<ServerSession> {
  const session = await requireUser();
  const dbUser = await db.user.findUnique({ where: { id: session.user.id }, select: { role: true, banned: true } });
  if (dbUser?.banned) throw new AuthError('This account has been suspended', 403);
  const role = (dbUser?.role as Role | undefined) ?? session.user.role;
  if (role === 'SELLER' || role === 'ADMIN') return { ...session, user: { ...session.user, role } };
  // Legacy heal: BUYER + owns a store -> SELLER (one-time, idempotent).
  const ownedStore = await db.store.findUnique({ where: { userId: session.user.id }, select: { id: true } });
  if (!ownedStore) throw new AuthError('You do not have permission to perform this action', 403);
  await db.user.update({ where: { id: session.user.id }, data: { role: 'SELLER' } });
  return { ...session, user: { ...session.user, role: 'SELLER' as Role } };
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Standard JSON error responses without stack traces (spec #73). */
export function authErrorResponse(e: unknown): Response | null {
  if (e instanceof AuthError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  return null;
}

// Production drift alarm (additive): the fallback secret in authOptions above
// is a DEV-ONLY convenience. If a production environment ever boots without
// NEXTAUTH_SECRET, sessions would be signed with a public string — loud log so
// drift is caught by the monitor/deploy pipeline instead of failing silently.
if (process.env.NODE_ENV === 'production' && !process.env.NEXTAUTH_SECRET) {
  console.error('SECURITY: NEXTAUTH_SECRET is not set in production — sessions would fall back to a public dev secret. Set it immediately.');
}
