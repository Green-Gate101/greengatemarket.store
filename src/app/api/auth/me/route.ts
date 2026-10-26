import { db } from '@/lib/db';
import { getSession, requireUser, authErrorResponse, sessionPasswordStale } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { googleEnabled } from '@/lib/auth';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';
import { rateLimit, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/** Current session profile + environment capability flags for the client. */
export async function GET() {
  try {
    await bootstrap();
    const session = await getSession();
    if (!session) {
      return Response.json({
        user: null,
        googleEnabled,
        emailDelivery: Boolean(process.env.RESEND_API_KEY),
      });
    }
    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, email: true, name: true, role: true, banned: true, emailVerified: true, phone: true, image: true, passwordHash: true },
    });
    if (!user) return Response.json({ user: null, googleEnabled, emailDelivery: false });
    // Signed in with a password that has since been reset — the header signs
    // this browser out (every API already refuses the session).
    if (sessionPasswordStale(session, user)) {
      return Response.json({ user: null, sessionExpired: true, googleEnabled, emailDelivery: Boolean(process.env.RESEND_API_KEY) });
    }
    return Response.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        banned: user.banned,
        emailVerified: Boolean(user.emailVerified),
        phone: user.phone,
        image: user.image,
      },
      googleEnabled,
      emailDelivery: Boolean(process.env.RESEND_API_KEY),
    });
  } catch (e) {
    console.error('me error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load the session.' }, { status: 500 });
  }
}

/** Update profile fields (name, phone). */
export async function PATCH(req: Request) {
  try {
    const session = await requireUser();
    // Generous per-account ceiling on changes (no person comes close; stops scripted floods).
    const writes = rateLimit(`account-writes:${session.user.id}`, 300, 60_000);
    if (!writes.allowed) return tooManyRequests(writes);
    const body = (await readJsonObject(req)) as { name?: string; phone?: string } | null;
    if (!body) return invalidJsonBody();
    const data: { name?: string; phone?: string | null } = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (name.length < 2) return Response.json({ error: 'Name must be at least 2 characters' }, { status: 400 });
      if (name.length > 120) return Response.json({ error: 'Name must be at most 120 characters' }, { status: 400 });
      data.name = name;
    }
    if (body.phone !== undefined) {
      const phone = String(body.phone).trim();
      if (phone.length > 30) return Response.json({ error: 'Phone number must be at most 30 characters' }, { status: 400 });
      data.phone = phone || null;
    }
    const user = await db.user.update({ where: { id: session.user.id }, data });
    return Response.json({ ok: true, user: { id: user.id, name: user.name, phone: user.phone } });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('me patch error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not update the profile.' }, { status: 500 });
  }
}
