import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireStoreSeller, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notify';
import { rateLimitShared, tooManyRequests } from '@/lib/rate-limit';
import { cleanMessageText } from '@/lib/messages';

export const dynamic = 'force-dynamic';

/**
 * The seller's text conversation with the Green Gate team (one thread per
 * store). GET lists it (newest 200, oldest first) and, with ?read=1, marks
 * Green Gate's messages as read. POST { body } sends a reply. Owner only;
 * plain text only. Open even while a subscription is unpaid — sellers must
 * always be able to reach support.
 */
export async function GET(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireStoreSeller();
    const store = await db.store.findUnique({ where: { userId: session.user.id }, select: { id: true } });
    if (!store) return Response.json({ messages: [], unread: 0 });
    const unread = await db.sellerMessage.count({ where: { storeId: store.id, fromAdmin: true, readAt: null } });
    if (new URL(req.url).searchParams.get('read') === '1' && unread > 0) {
      await db.sellerMessage.updateMany({ where: { storeId: store.id, fromAdmin: true, readAt: null }, data: { readAt: new Date() } });
    }
    const rows = await db.sellerMessage.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, fromAdmin: true, body: true, createdAt: true, readAt: true },
    });
    return Response.json({
      unread,
      messages: rows.reverse().map((m) => ({ ...m, createdAt: m.createdAt.toISOString(), readAt: m.readAt?.toISOString() ?? null })),
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('seller messages GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load your messages.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireStoreSeller();
    const rl = await rateLimitShared(`seller-message:${session.user.id}`, 30, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const store = await db.store.findUnique({ where: { userId: session.user.id }, select: { id: true, name: true } });
    if (!store) return Response.json({ error: 'Create your store first.' }, { status: 404 });
    let raw: unknown;
    try {
      raw = ((await req.json()) as { body?: unknown }).body;
    } catch {
      return Response.json({ error: 'Write a message first.' }, { status: 400 });
    }
    const text = cleanMessageText(raw);
    if (!text.ok) return Response.json({ error: text.error }, { status: 400 });
    const message = await db.sellerMessage.create({
      data: { storeId: store.id, fromAdmin: false, authorId: session.user.id, body: text.value },
      select: { id: true, fromAdmin: true, body: true, createdAt: true },
    });
    // Tell the administrators (in-app bell) — best effort.
    const admins = await db.user.findMany({ where: { role: 'ADMIN', banned: false }, select: { id: true }, take: 20 });
    for (const a of admins) {
      void notify({ userId: a.id, type: 'seller_message', title: `Message from ${store.name}`, body: text.value.slice(0, 140), link: '/admin' });
    }
    await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'seller_message_sent', target: store.id, detail: `${text.value.length} characters` }).catch(() => undefined);
    return Response.json({ ok: true, message: { ...message, createdAt: message.createdAt.toISOString() } }, { status: 201 });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('seller messages POST error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not send your message.' }, { status: 500 });
  }
}
