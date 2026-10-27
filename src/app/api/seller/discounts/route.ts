import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireStoreSeller, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { audit } from '@/lib/audit';
import { rateLimitShared, tooManyRequests } from '@/lib/rate-limit';
import { requireSellerTools } from '@/lib/subscription';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';
import { DISCOUNT_CODE_RE, MAX_ACTIVE_CODES_PER_STORE, discountConditions, discountLabel, normalizeCode } from '@/lib/discounts';

export const dynamic = 'force-dynamic';

type Row = Awaited<ReturnType<typeof db.discountCode.findMany>>[number];
const view = (c: Row) => ({
  id: c.id, code: c.code, percentOff: c.percentOff, amountOffCents: c.amountOffCents,
  minSubtotalCents: c.minSubtotalCents, firstOrderOnly: c.firstOrderOnly, maxUses: c.maxUses, usedCount: c.usedCount,
  expiresAt: c.expiresAt?.toISOString() ?? null, active: c.active, disabledByAdmin: c.disabledByAdmin,
  createdAt: c.createdAt.toISOString(), label: discountLabel(c), conditions: discountConditions(c),
});

async function ownStore(userId: string) {
  return db.store.findUnique({ where: { userId }, select: { id: true, name: true } });
}

/** The seller's own discount codes, newest first. */
export async function GET() {
  try {
    await bootstrap();
    const session = await requireStoreSeller();
    const store = await ownStore(session.user.id);
    if (!store) return Response.json({ codes: [] });
    const codes = await db.discountCode.findMany({ where: { storeId: store.id }, orderBy: { createdAt: 'desc' }, take: 200 });
    return Response.json({ codes: codes.map(view) });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('seller discounts GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load your discount codes.' }, { status: 500 });
  }
}

/**
 * Create a code: { code, percentOff | amountOffCents, minSubtotalCents?,
 * firstOrderOnly?, maxUses?, expiresOn? (YYYY-MM-DD, last day it works) }.
 */
export async function POST(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireStoreSeller();
    const rl = await rateLimitShared(`seller-discount:${session.user.id}`, 40, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    await requireSellerTools(session.user.id);
    const store = await ownStore(session.user.id);
    if (!store) return Response.json({ error: 'Create your store first.' }, { status: 404 });

    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const code = normalizeCode(body.code);
    if (!DISCOUNT_CODE_RE.test(code)) {
      return Response.json({ error: 'Codes use 3–20 letters, numbers or dashes (for example WELCOME10).' }, { status: 400 });
    }
    const hasPercent = body.percentOff !== undefined && body.percentOff !== null && body.percentOff !== '';
    const hasAmount = body.amountOffCents !== undefined && body.amountOffCents !== null && body.amountOffCents !== '';
    if (hasPercent === hasAmount) return Response.json({ error: 'Choose either a percentage or a rand amount off.' }, { status: 400 });
    const percentOff = hasPercent ? Number(body.percentOff) : null;
    const amountOffCents = hasAmount ? Number(body.amountOffCents) : null;
    if (percentOff !== null && (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 90)) {
      return Response.json({ error: 'The percentage must be a whole number from 1 to 90.' }, { status: 400 });
    }
    if (amountOffCents !== null && (!Number.isInteger(amountOffCents) || amountOffCents < 100 || amountOffCents > 1_000_000)) {
      return Response.json({ error: 'The amount off must be between R1 and R10 000.' }, { status: 400 });
    }
    const minSubtotalCents = body.minSubtotalCents === undefined || body.minSubtotalCents === null || body.minSubtotalCents === '' ? 0 : Number(body.minSubtotalCents);
    if (!Number.isInteger(minSubtotalCents) || minSubtotalCents < 0 || minSubtotalCents > 10_000_000) {
      return Response.json({ error: 'The minimum spend must be between R0 and R100 000.' }, { status: 400 });
    }
    const maxUses = body.maxUses === undefined || body.maxUses === null || body.maxUses === '' ? null : Number(body.maxUses);
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100_000)) {
      return Response.json({ error: 'The number of uses must be between 1 and 100 000 (or leave it empty for no limit).' }, { status: 400 });
    }
    let expiresAt: Date | null = null;
    if (body.expiresOn !== undefined && body.expiresOn !== null && body.expiresOn !== '') {
      const day = String(body.expiresOn);
      // The code works until the end of that day, South African time.
      expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T23:59:59+02:00`) : null;
      if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
        return Response.json({ error: 'Choose an end date that is today or later.' }, { status: 400 });
      }
    }
    const activeCount = await db.discountCode.count({ where: { storeId: store.id, active: true } });
    if (activeCount >= MAX_ACTIVE_CODES_PER_STORE) {
      return Response.json({ error: `You can have up to ${MAX_ACTIVE_CODES_PER_STORE} active codes — switch one off first.` }, { status: 409 });
    }
    const taken = await db.discountCode.findUnique({ where: { storeId_code: { storeId: store.id, code } }, select: { id: true } });
    if (taken) return Response.json({ error: `You already have a code called ${code}. Pick another name.` }, { status: 409 });

    const created = await db.discountCode.create({
      data: { storeId: store.id, code, percentOff, amountOffCents, minSubtotalCents, firstOrderOnly: body.firstOrderOnly === true, maxUses, expiresAt },
    });
    await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'discount_code_created', target: store.id, detail: `${code} · ${discountLabel(created)} · ${discountConditions(created).join(', ')}` });
    return Response.json({ ok: true, code: view(created) }, { status: 201 });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    const unique = typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 'P2002';
    if (unique) return Response.json({ error: 'You already have a code with that name. Pick another name.' }, { status: 409 });
    console.error('seller discounts POST error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not create the code.' }, { status: 500 });
  }
}

/** Switch one of the seller's codes on or off: { id, active }. */
export async function PATCH(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireStoreSeller();
    const rl = await rateLimitShared(`seller-discount:${session.user.id}`, 40, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    await requireSellerTools(session.user.id);
    const store = await ownStore(session.user.id);
    if (!store) return Response.json({ error: 'Create your store first.' }, { status: 404 });
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const id = String(body.id ?? '');
    if (typeof body.active !== 'boolean') return Response.json({ error: 'Say whether the code is on or off.' }, { status: 400 });
    const row = await db.discountCode.findFirst({ where: { id, storeId: store.id } });
    if (!row) return Response.json({ error: 'Code not found.' }, { status: 404 });
    if (body.active && row.disabledByAdmin) {
      return Response.json({ error: 'Green Gate switched this code off. Message Green Gate from your dashboard if you have questions.' }, { status: 409 });
    }
    if (body.active && !row.active) {
      const activeCount = await db.discountCode.count({ where: { storeId: store.id, active: true } });
      if (activeCount >= MAX_ACTIVE_CODES_PER_STORE) {
        return Response.json({ error: `You can have up to ${MAX_ACTIVE_CODES_PER_STORE} active codes — switch one off first.` }, { status: 409 });
      }
    }
    const updated = await db.discountCode.update({ where: { id: row.id }, data: { active: body.active } });
    await audit({ actorId: session.user.id, actorEmail: session.user.email, action: body.active ? 'discount_code_on' : 'discount_code_off', target: store.id, detail: row.code });
    return Response.json({ ok: true, code: view(updated) });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('seller discounts PATCH error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not update the code.' }, { status: 500 });
  }
}
