import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireStoreSeller, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { audit } from '@/lib/audit';
import { rateLimitShared, tooManyRequests } from '@/lib/rate-limit';
import { requireSellerTools } from '@/lib/subscription';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';
import { PICKUP_ETAS, PICKUP_KINDS, PICKUP_MAX_CENTS } from '@/lib/pickup';
import { formatMoney } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * The seller's pickup-point delivery (PAXI points, Pudo lockers): on/off, the
 * price buyers pay and the delivery time the seller books. Body:
 * { paxi: { on, priceCents, eta }, pudo: { on, priceCents, eta } } — a kind
 * left out is unchanged. Owner only; every change is audited.
 */
export async function PATCH(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireStoreSeller();
    const rl = await rateLimitShared(`seller-pickup:${session.user.id}`, 30, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    await requireSellerTools(session.user.id);

    const store = await db.store.findUnique({ where: { userId: session.user.id }, select: { id: true, name: true } });
    if (!store) return Response.json({ error: 'Create your store first.' }, { status: 404 });

    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();

    const data: { pickupPaxiCents?: number | null; pickupPaxiEta?: string | null; pickupPudoCents?: number | null; pickupPudoEta?: string | null } = {};
    const notes: string[] = [];
    for (const kind of PICKUP_KINDS) {
      const raw = body[kind];
      if (raw === undefined) continue;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return Response.json({ error: `Send the ${kind.toUpperCase()} settings as an object.` }, { status: 400 });
      const v = raw as { on?: unknown; priceCents?: unknown; eta?: unknown };
      const name = kind === 'paxi' ? 'PAXI' : 'Pudo';
      const priceKey = kind === 'paxi' ? 'pickupPaxiCents' : 'pickupPudoCents';
      const etaKey = kind === 'paxi' ? 'pickupPaxiEta' : 'pickupPudoEta';
      if (v.on !== true) {
        data[priceKey] = null;
        data[etaKey] = null;
        notes.push(`${name} off`);
        continue;
      }
      const price = Number(v.priceCents);
      if (!Number.isInteger(price) || price < 100 || price > PICKUP_MAX_CENTS) {
        return Response.json({ error: `Set the ${name} price buyers pay — between R1 and ${formatMoney(PICKUP_MAX_CENTS)}.` }, { status: 400 });
      }
      const eta = String(v.eta ?? '');
      if (!(PICKUP_ETAS as readonly string[]).includes(eta)) {
        return Response.json({ error: `Choose the ${name} delivery time you book.` }, { status: 400 });
      }
      data[priceKey] = price;
      data[etaKey] = eta;
      notes.push(`${name} ${formatMoney(price)} ${eta}d`);
    }
    if (notes.length === 0) return Response.json({ error: 'Nothing to change.' }, { status: 400 });

    await db.store.update({ where: { id: store.id }, data });
    await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'store_pickup_updated', target: store.id, detail: notes.join(' · ') });
    return Response.json({ ok: true });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('seller pickup PATCH error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not save your pickup-point settings.' }, { status: 500 });
  }
}
