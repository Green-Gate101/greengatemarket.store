import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { rateLimitShared, tooManyRequests } from '@/lib/rate-limit';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';
import { DISCOUNT_CODE_RE, checkDiscount, discountConditions, discountLabel, normalizeCode } from '@/lib/discounts';

export const dynamic = 'force-dynamic';

/**
 * Preview a discount code against the signed-in buyer's cart: which stores'
 * items it takes money off, and by how much. Nothing is reserved here —
 * checkout checks every rule again and claims the use.
 */
export async function POST(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireUser();
    // Codes are short — a guessing loop must not be able to try thousands.
    const rl = await rateLimitShared(`discount-check:${session.user.id}`, 30, 10 * 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const code = normalizeCode(body.code);
    if (!DISCOUNT_CODE_RE.test(code)) return Response.json({ error: 'Enter the code exactly as you received it.' }, { status: 400 });

    const lines = await db.cartItem.findMany({
      where: { userId: session.user.id },
      select: {
        quantity: true,
        product: { select: { storeId: true, priceCents: true, salePriceCents: true, store: { select: { name: true } } } },
        variant: { select: { priceCents: true } },
      },
    });
    const byStore = new Map<string, { name: string; subtotalCents: number }>();
    for (const l of lines) {
      const unit = l.variant?.priceCents ?? l.product.salePriceCents ?? l.product.priceCents;
      const s = byStore.get(l.product.storeId) ?? { name: l.product.store.name, subtotalCents: 0 };
      s.subtotalCents += unit * l.quantity;
      byStore.set(l.product.storeId, s);
    }

    const applies: { storeId: string; storeName: string; discountCents: number; label: string; conditions: string[] }[] = [];
    const problems: { storeName: string; reason: string }[] = [];
    for (const [storeId, s] of byStore) {
      const result = await checkDiscount(db, { code, storeId, subtotalCents: s.subtotalCents, buyerId: session.user.id });
      if (result.ok) applies.push({ storeId, storeName: s.name, discountCents: result.discountCents, label: discountLabel(result.row), conditions: discountConditions(result.row) });
      else if (result.exists) problems.push({ storeName: s.name, reason: result.reason });
    }
    if (applies.length === 0) {
      return Response.json({ error: problems[0] ? `${problems[0].reason}` : 'This code is not valid for the items in your cart.', problems }, { status: 422 });
    }
    return Response.json({ code, applies, problems, discountCents: applies.reduce((n, a) => n + a.discountCents, 0) });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('discount check error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not check the code. Please try again.' }, { status: 500 });
  }
}
