import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';
import { rateLimit, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;

/**
 * In-app notifications for the signed-in user.
 *  GET  → latest page + unread badge count.
 *  POST → mark one ({ id }) or all ({ all: true }) as read; every write is
 *         scoped to the caller's own rows, so cross-user tampering is impossible.
 */
export async function GET() {
  try {
    await bootstrap();
    const session = await requireUser();
    const [notifications, unread] = await Promise.all([
      db.notification.findMany({
        where: { userId: session.user.id },
        orderBy: { createdAt: 'desc' },
        take: PAGE_SIZE,
        select: { id: true, type: true, title: true, body: true, link: true, readAt: true, createdAt: true },
      }),
      db.notification.count({ where: { userId: session.user.id, readAt: null } }),
    ]);
    return Response.json({ notifications, unread });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('notifications error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load notifications.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireUser();
    // Generous per-account ceiling on changes (no person comes close; stops scripted floods).
    const writes = rateLimit(`account-writes:${session.user.id}`, 300, 60_000);
    if (!writes.allowed) return tooManyRequests(writes);
    const body = (await readJsonObject(req)) as { id?: string; all?: boolean } | null;
    if (!body) return invalidJsonBody();

    if (body.all) {
      const res = await db.notification.updateMany({
        where: { userId: session.user.id, readAt: null },
        data: { readAt: new Date() },
      });
      return Response.json({ ok: true, updated: res.count });
    }

    if (body.id) {
      await db.notification.updateMany({
        where: { id: body.id, userId: session.user.id, readAt: null },
        data: { readAt: new Date() },
      });
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Nothing to update.' }, { status: 400 });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('notifications mark-read error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not update notifications.' }, { status: 500 });
  }
}
