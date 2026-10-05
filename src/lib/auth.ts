import type { NextAuthOptions } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import { getServerSession } from 'next-auth';
import { db } from '@/lib/db';
import { verifyPassword } from '@/lib/password';
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
  secret: process.env.NEXTAUTH_SECRET,
  pages: { signIn: '/', error: '/' },
  providers: [
    Credentials({
      name: 'Email & password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase();
        const password = credentials?.password ?? '';
        if (!email || !password) return null;
        const user = await db.user.findUnique({ where: { email } });
        if (!user || !user.passwordHash) return null;
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
    async jwt({ token, user, profile }) {
      if (user) {
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
  const session = await getServerSession(authOptions);
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

export async function requireUser(): Promise<ServerSession> {
  const session = await getSession();
  if (!session) throw new AuthError('Sign in to continue', 401);
  return session;
}

export async function requireRole(...roles: Role[]): Promise<ServerSession> {
  const session = await requireUser();
  // Re-verify role from the database — the token is not authoritative.
  const dbUser = await db.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  const role = (dbUser?.role as Role | undefined) ?? session.user.role;
  if (!roles.includes(role)) throw new AuthError('You do not have permission to perform this action', 403);
  return { ...session, user: { ...session.user, role } };
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
