import { db } from '@/lib/db';
import { generateToken, hashPassword } from '@/lib/password';
import { sendPasswordResetEmail } from '@/lib/email';
import { audit } from '@/lib/audit';
import { rateLimitShared, clientIp, tooManyRequests } from '@/lib/rate-limit';
import { bootstrap } from '@/lib/bootstrap';
import { emailLinkOrigin } from '@/lib/origin';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';

export const dynamic = 'force-dynamic';

/** Step 1 — request a reset link. Rate limited, enumeration-safe. */
export async function POST(req: Request) {
  const ip = clientIp(req);
  // Per IP generously (carrier NAT shares IPs) + per email strictly below.
  const rl = await rateLimitShared(`reset-request:${ip}`, 20, 60 * 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  try {
    await bootstrap();
    const body = (await readJsonObject(req)) as { email?: string } | null;
    if (!body) return invalidJsonBody();
    const email = String(body.email ?? '').trim().toLowerCase();
    const generic = { ok: true, message: 'If an account exists for that email, a reset link has been sent.' };

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json(generic);
    // At most 5 reset emails per address per hour (inbox-bombing guard);
    // the answer stays the generic one so account existence never leaks.
    const perEmail = await rateLimitShared(`reset-email:${email}`, 5, 60 * 60_000);
    if (!perEmail.allowed) return Response.json(generic);

    const user = await db.user.findUnique({ where: { email } });
    if (user) {
      const token = generateToken();
      await db.authToken.create({
        data: { identifier: email, token, purpose: 'password_reset', expires: new Date(Date.now() + 3600_000) },
      });
      // emailLinkOrigin never trusts a cross-origin Origin header — a poisoned
      // reset link would otherwise leak the 1h token to an attacker's site
      // and hand over the account.
      const origin = emailLinkOrigin(req);
      const sent = await sendPasswordResetEmail({ to: email, url: `${origin}/?reset=${token}` });
      await audit({ actorEmail: email, action: 'password_reset_requested', ip, detail: sent ? 'emailed' : 'email_failed' });
    }
    return Response.json(generic);
  } catch (e) {
    console.error('reset request error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not process the request.' }, { status: 500 });
  }
}

/** Step 2 — set the new password with a valid 1h token. */
export async function PUT(req: Request) {
  const ip = clientIp(req);
  const rl = await rateLimitShared(`reset-confirm:${ip}`, 10, 60 * 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  try {
    const body = (await readJsonObject(req)) as { token?: string; password?: string } | null;
    if (!body) return invalidJsonBody();
    const token = String(body.token ?? '');
    const password = String(body.password ?? '');

    const issues: string[] = [];
    if (!token) issues.push('Reset link is invalid');
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      issues.push('Password needs at least 8 characters including a letter and a number');
    }
    if (issues.length > 0) return Response.json({ error: issues.join('. ') }, { status: 400 });

    const record = await db.authToken.findUnique({ where: { token } });
    if (!record || record.purpose !== 'password_reset' || record.usedAt || record.expires < new Date()) {
      return Response.json({ error: 'This reset link is invalid or has expired. Request a new one.' }, { status: 400 });
    }

    const user = await db.user.findUnique({ where: { email: record.identifier } });
    if (!user) return Response.json({ error: 'Account not found.' }, { status: 404 });

    // Single use, atomically: the token is claimed (usedAt set) in the same
    // transaction only if still unused, so two parallel submissions can never
    // both reset the password with one link.
    const claimed = await db.$transaction(async (tx) => {
      const claim = await tx.authToken.updateMany({ where: { token, usedAt: null }, data: { usedAt: new Date() } });
      if (claim.count === 0) return false;
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(password) } });
      return true;
    });
    if (!claimed) {
      return Response.json({ error: 'This reset link is invalid or has expired. Request a new one.' }, { status: 400 });
    }

    await audit({ actorId: user.id, actorEmail: user.email, action: 'password_reset_completed', ip });
    return Response.json({ ok: true, message: 'Password updated. Sign in with your new password.' });
  } catch (e) {
    console.error('reset confirm error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not update the password.' }, { status: 500 });
  }
}
