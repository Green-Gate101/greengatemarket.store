import { db } from '@/lib/db';
import { hashPassword, passwordIssues, generateToken } from '@/lib/password';
import { sendVerificationEmail } from '@/lib/email';
import { audit } from '@/lib/audit';
import { rateLimitShared, clientIp, tooManyRequests } from '@/lib/rate-limit';
import { bootstrap } from '@/lib/bootstrap';
import { emailLinkOrigin } from '@/lib/origin';

export const dynamic = 'force-dynamic';

/**
 * Buyer/seller registration. Creates an unverified account, emails a
 * verification link (real Resend delivery, 24h token). Rate limited.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  // Shared across instances. Mobile networks put many real customers behind
  // one IP (carrier NAT), so the per-IP ceiling is generous; one address can
  // still only register once (unique email).
  const rl = await rateLimitShared(`register:${ip}`, 20, 60 * 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  try {
    await bootstrap();
    const body = (await req.json()) as { name?: string; email?: string; password?: string; phone?: string };
    const name = String(body.name ?? '').trim();
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const phone = String(body.phone ?? '').trim() || null;

    const errors: string[] = [];
    if (name.length < 2) errors.push('Enter your full name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Enter a valid email address');
    const pwIssues = passwordIssues(password);
    if (pwIssues.length > 0) errors.push(`Password needs ${pwIssues.join(', ')}`);
    if (errors.length > 0) return Response.json({ error: errors.join('. ') }, { status: 400 });

    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      // Do not reveal account existence beyond this standard message.
      return Response.json({ error: 'An account with this email already exists. Sign in instead.' }, { status: 409 });
    }

    const user = await db.user.create({
      data: { name, email, phone, passwordHash: hashPassword(password), role: 'BUYER' },
    });

    const token = generateToken();
    await db.authToken.create({
      data: { identifier: email, token, purpose: 'email_verify', expires: new Date(Date.now() + 24 * 3600_000) },
    });

    // emailLinkOrigin never trusts a cross-origin Origin header — verification
    // links must always point at THIS deployment.
    const origin = emailLinkOrigin(req);
    await sendVerificationEmail({ to: email, name, url: `${origin}/api/auth/verify?token=${token}` });

    // Persistent welcome notification — visible the moment the account is used.
    void (async () => {
      const { notify } = await import('@/lib/notify');
      await notify({
        userId: user.id,
        type: 'welcome',
        title: 'Welcome to Green Gate',
        body: 'Your account is ready. Browse stores, save favourites and check out when you are ready.',
        link: '/',
      });
    })();

    await audit({ actorId: user.id, actorEmail: email, action: 'account_registered', ip });
    return Response.json({ ok: true, message: 'Account created. Check your email to verify your address.' }, { status: 201 });
  } catch (e) {
    console.error('register error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not create the account. Please try again.' }, { status: 500 });
  }
}
