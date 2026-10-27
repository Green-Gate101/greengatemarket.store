import type { Prisma, DiscountCode } from '@prisma/client';
import { db } from '@/lib/db';
import { formatMoney } from '@/lib/types';

/**
 * Seller discount codes. A seller creates codes for their own store and
 * funds them: the discount comes off that store's items (never delivery), so
 * the buyer pays the seller less through the seller's own payment provider.
 * Rules are checked on the server at checkout — the cart only previews them.
 */

/** A–Z, 0–9 and dashes, 3–20 characters, stored upper case. */
export const DISCOUNT_CODE_RE = /^[A-Z0-9-]{3,20}$/;

/** A store's items never cost less than this after a discount — payment providers need an amount. */
export const MIN_ITEMS_CENTS_AFTER_DISCOUNT = 500;

export const MAX_ACTIVE_CODES_PER_STORE = 50;

export function normalizeCode(raw: unknown): string {
  return String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

/** The amount a code takes off a store's items (capped so something is still paid). */
export function discountAmount(code: Pick<DiscountCode, 'percentOff' | 'amountOffCents'>, subtotalCents: number): number {
  const raw = code.percentOff ? Math.round((subtotalCents * code.percentOff) / 100) : (code.amountOffCents ?? 0);
  return Math.max(0, Math.min(raw, subtotalCents - MIN_ITEMS_CENTS_AFTER_DISCOUNT));
}

/** "10% off" / "R50.00 off" — what the buyer is promised. */
export function discountLabel(code: Pick<DiscountCode, 'percentOff' | 'amountOffCents'>): string {
  return code.percentOff ? `${code.percentOff}% off` : `${formatMoney(code.amountOffCents ?? 0)} off`;
}

/** The code's conditions in plain words (for the seller list and the buyer's cart). */
export function discountConditions(code: Pick<DiscountCode, 'minSubtotalCents' | 'firstOrderOnly' | 'maxUses' | 'expiresAt'>): string[] {
  const out: string[] = [];
  if (code.minSubtotalCents > 0) out.push(`spend at least ${formatMoney(code.minSubtotalCents)}`);
  if (code.firstOrderOnly) out.push('first order on Green Gate only');
  if (code.maxUses !== null) out.push(`${code.maxUses} use${code.maxUses === 1 ? '' : 's'} in total`);
  if (code.expiresAt) out.push(`ends ${code.expiresAt.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Johannesburg' })}`);
  out.push('once per buyer');
  return out;
}

type Client = Prisma.TransactionClient | typeof db;

export type DiscountCheck =
  | { ok: true; row: DiscountCode; discountCents: number }
  | { ok: false; reason: string; exists: boolean };

/**
 * Does `code` apply to this buyer's order from this store? Reads only — the
 * use itself is claimed inside the checkout transaction (claimDiscountUse).
 */
export async function checkDiscount(
  client: Client,
  { code, storeId, subtotalCents, buyerId, now = new Date() }: { code: string; storeId: string; subtotalCents: number; buyerId: string; now?: Date },
): Promise<DiscountCheck> {
  const row = await client.discountCode.findUnique({ where: { storeId_code: { storeId, code } } });
  if (!row) return { ok: false, reason: 'This code is not valid for this store.', exists: false };
  if (!row.active || row.disabledByAdmin) return { ok: false, reason: 'This code is no longer active.', exists: true };
  if (row.expiresAt && row.expiresAt.getTime() < now.getTime()) return { ok: false, reason: 'This code has expired.', exists: true };
  if (row.maxUses !== null && row.usedCount >= row.maxUses) return { ok: false, reason: 'This code has been used up.', exists: true };
  if (subtotalCents < row.minSubtotalCents) {
    return { ok: false, reason: `Spend at least ${formatMoney(row.minSubtotalCents)} at this store to use this code.`, exists: true };
  }
  if (row.firstOrderOnly) {
    const paidBefore = await client.order.count({ where: { buyerId, paymentStatus: 'paid' } });
    if (paidBefore > 0) return { ok: false, reason: 'This code is for your first order on Green Gate.', exists: true };
  }
  const usedBefore = await client.order.count({ where: { buyerId, discountCodeId: row.id, status: { not: 'cancelled' } } });
  if (usedBefore > 0) return { ok: false, reason: 'You have already used this code.', exists: true };
  const discountCents = discountAmount(row, subtotalCents);
  if (discountCents <= 0) return { ok: false, reason: 'This order is too small for this code.', exists: true };
  return { ok: true, row, discountCents };
}

/**
 * Claim one use inside the checkout transaction. With a use limit the claim
 * is conditional, so two buyers at the same moment can never take the last
 * use twice. Returns false when the code has just been used up.
 */
export async function claimDiscountUse(tx: Prisma.TransactionClient, row: Pick<DiscountCode, 'id' | 'maxUses'>): Promise<boolean> {
  if (row.maxUses === null) {
    await tx.discountCode.update({ where: { id: row.id }, data: { usedCount: { increment: 1 } } });
    return true;
  }
  const claimed = await tx.discountCode.updateMany({ where: { id: row.id, usedCount: { lt: row.maxUses } }, data: { usedCount: { increment: 1 } } });
  return claimed.count === 1;
}

/** A cancelled order gives its code use back (same transaction as the cancellation). */
export async function releaseDiscountUse(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { discountCodeId: true } });
  if (order?.discountCodeId) {
    await tx.discountCode.updateMany({ where: { id: order.discountCodeId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
  }
}
