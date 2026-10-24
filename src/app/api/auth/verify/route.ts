import { db } from '@/lib/db';
import { audit } from '@/lib/audit';
import { rateLimitShared, clientIp, tooManyRequests } from '@/lib/rate-limit';
import { emailLinkOrigin } from '@/lib/origin';

export const dynamic = 'force-dynamic';

/** Email verification callback: consumes a 24h token, marks the address verified. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') ?? '';
  if (!token) return Response.redirect(new URL('/?verify=invalid', url.origin), 302);

  const record = await db.authToken.findUnique({ where: { token } });
  if (!record || record.purpose !== 'email_verify' || record.usedAt || record.expires < new Date()) {
    return Response.redirect(new URL('/?verify=invalid', url.origin), 302);
  }

  const user = await db.user.findUnique({ where: { email: record.identifier } });
  if (!user) return Response.redirect(new URL('/?verify=invalid', url.origin), 302);

  // Single use, atomically (same rule as password reset).
  const claimed = await db.$transaction(async (tx) => {
    const claim = await tx.authToken.updateMany({ where: { token, usedAt: null }, data: { usedAt: new Date() } });
    if (claim.count === 0) return false;
    await tx.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } });
    return true;
  });
  if (!claimed) return Response.redirect(new URL('/?verify=invalid', url.origin), 302);

  await audit({ actorId: user.id, actorEmail: user.email, action: 'email_verified' });
  return Response.redirect(new URL('/?verify=ok', url.origin), 302);
}

/** Resend the verification email for the signed-in user. */
export async function POST(req: Request) {
  // Rate limited: this endpoint creates a fresh 24h token and a real email
  // delivery per call — unthrottled it is an email-bombing vector.
  // Per IP generously (carrier NAT shares IPs) + per email strictly below.
  const rl = await rateLimitShared(`verify-resend:${clientIp(req)}`, 20, 60 * 60_000);
  if (!rl.allowed) return tooManyRequests(rl);
  try {
    const body = (await req.json()) as { email?: string };
    const email = String(body.email ?? '').trim().toLowerCase();
    const generic = { ok: true, message: 'If that address needs verification, a new link has been sent.' };
    const perEmail = await rateLimitShared(`verify-email:${email}`, 5, 60 * 60_000);
    if (!perEmail.allowed) return Response.json(generic);
    const user = await db.user.findUnique({ where: { email } });
    // Uniform response regardless of account existence (enumeration defence).
    if (!user || user.emailVerified) {
      return Response.json({ ok: true, message: 'If that address needs verification, a new link has been sent.' });
    }
    const { generateToken } = await import('@/lib/password');
    const { sendVerificationEmail } = await import('@/lib/email');
    const token = generateToken();
    await db.authToken.create({
      data: { identifier: email, token, purpose: 'email_verify', expires: new Date(Date.now() + 24 * 3600_000) },
    });
    // emailLinkOrigin never trusts a cross-origin Origin header —
    // verification links must always point at THIS deployment.
    const origin = emailLinkOrigin(req);
    await sendVerificationEmail({ to: email, name: user.name ?? '', url: `${origin}/api/auth/verify?token=${token}` });
    return Response.json({ ok: true, message: 'If that address needs verification, a new link has been sent.' });
  } catch (e) {
    console.error('verify resend error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not send the verification email.' }, { status: 500 });
  }
}
