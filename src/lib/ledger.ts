import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

/**
 * The marketplace's double-entry wallet ledger (additive — nothing existing
 * changes). Every rand that moves through a platform-collected payment is a
 * PAIR of append-only LedgerEntry rows (a debit on the source account and a
 * credit on the destination account), so:
 *   - balances are always derivable (credits − debits per account),
 *   - every movement is auditable (refType + refId point at the order,
 *     payout, courier booking or refund that caused it),
 *   - seller earnings from in-app payments are HELD until The Courier Guy
 *     confirms collection — escrow, exactly like Takealot/Amazon.
 *
 * Account kinds:
 *   platform_cash     — money actually received from buyers (nets to ~0 after
 *                       each settlement splits it; negative only when a
 *                       marketplace discount was absorbed)
 *   seller_escrow     — per-store earnings held until shipment proof
 *   platform_shipping — the courier budget collected from buyers (spent when
 *                       a TCG booking succeeds)
 *   platform_fees     — marketplace commission earned
 *   buyer             — refunds owed/paid back to a buyer
 *   courier_tcg       — cumulative spend at The Courier Guy
 *   seller_paid       — earnings that left the platform via a paid-out payout
 *
 * All helpers accept either the plain client or a transaction client, so
 * callers can write ledger pairs atomically inside their own transactions.
 */

export type Client = Prisma.TransactionClient | typeof db;

export type WalletKind =
  | 'platform_cash'
  | 'platform_shipping'
  | 'platform_fees'
  | 'seller_escrow'
  | 'seller_paid'
  | 'buyer'
  | 'courier_tcg';

export const WALLET_KIND_LABEL: Record<WalletKind, string> = {
  platform_cash: 'Cash received from buyers',
  seller_escrow: 'Seller earnings held in escrow',
  platform_shipping: 'Courier budget (buyer shipping fees)',
  platform_fees: 'Marketplace commission earned',
  seller_paid: 'Paid out to sellers',
  buyer: 'Refunds back to buyers',
  courier_tcg: 'Spent at The Courier Guy',
};

/** Find or create an account (idempotent — safe under races). */
export async function ensureAccount(g: Client, kind: WalletKind, refId: string | null, label?: string) {
  // findFirst (not the compound-unique lookup): refId is nullable, and NULL
  // accounts can only be matched with a plain where (NULL ≠ NULL in SQL).
  const existing = await g.walletAccount.findFirst({ where: { kind, refId } });
  if (existing) return existing;
  try {
    return await g.walletAccount.create({ data: { kind, refId, label: label ?? null } });
  } catch {
    // A parallel request created it first — read it back.
    const acc = await g.walletAccount.findFirst({ where: { kind, refId } });
    if (!acc) throw new Error(`wallet account ${kind}:${refId ?? '∅'} could not be created`);
    return acc;
  }
}

export interface LedgerLeg {
  kind: WalletKind;
  refId?: string | null;
  label?: string;
}

export interface PairSpec {
  amountCents: number;
  from: LedgerLeg;
  to: LedgerLeg;
  state: string; // held | released | settled | refunded
  refType: string; // order | payout | courier_booking | refund | adjustment
  refId: string;
  memo?: string;
}

/**
 * Write ONE double-entry pair (debit `from`, credit `to`). The caller picks
 * the state for each leg — e.g. a settlement credits the seller's escrow as
 * `held` while the matching platform_cash debit is `settled`.
 */
export async function recordPair(
  g: Client,
  spec: PairSpec,
  states?: { from?: string; to?: string },
): Promise<void> {
  const amount = Math.round(spec.amountCents);
  if (!Number.isFinite(amount) || amount <= 0) return; // zero-value legs are never written
  const src = await ensureAccount(g, spec.from.kind, spec.from.refId ?? null, spec.from.label);
  const dst = await ensureAccount(g, spec.to.kind, spec.to.refId ?? null, spec.to.label);
  await g.ledgerEntry.create({
    data: {
      accountId: src.id, direction: 'debit', amountCents: amount,
      state: states?.from ?? spec.state, refType: spec.refType, refId: spec.refId, memo: spec.memo ?? null,
    },
  });
  await g.ledgerEntry.create({
    data: {
      accountId: dst.id, direction: 'credit', amountCents: amount,
      state: states?.to ?? spec.state, refType: spec.refType, refId: spec.refId, memo: spec.memo ?? null,
    },
  });
}

/** Credits − debits for one account. */
export async function accountBalanceCents(g: Client, kind: WalletKind, refId: string | null): Promise<number> {
  const acc = await g.walletAccount.findFirst({
    where: { kind, refId },
    include: { entries: { select: { direction: true, amountCents: true } } },
  });
  if (!acc) return 0;
  return acc.entries.reduce((sum, e) => sum + (e.direction === 'credit' ? e.amountCents : -e.amountCents), 0);
}

export interface WalletBalance {
  kind: WalletKind;
  refId: string | null;
  label: string | null;
  kindLabel: string;
  cents: number;
}

/** Every account with a non-zero movement, for the admin Finance view. */
export async function walletBalances(): Promise<WalletBalance[]> {
  const accounts = await db.walletAccount.findMany({
    include: { entries: { select: { direction: true, amountCents: true } } },
    orderBy: { kind: 'asc' },
  });
  return accounts
    .map((a) => ({
      kind: a.kind as WalletKind,
      refId: a.refId,
      label: a.label,
      kindLabel: WALLET_KIND_LABEL[a.kind as WalletKind] ?? a.kind,
      cents: a.entries.reduce((sum, e) => sum + (e.direction === 'credit' ? e.amountCents : -e.amountCents), 0),
    }))
    .filter((b) => b.cents !== 0)
    .sort((x, y) => y.cents - x.cents);
}

export interface LedgerRow {
  id: string;
  at: string;
  kind: WalletKind;
  refId: string | null;
  direction: string;
  amountCents: number;
  state: string;
  refType: string;
  ref: string;
  memo: string | null;
}

/** The newest ledger movements (admin Finance tail). */
export async function recentLedgerRows(limit = 60): Promise<LedgerRow[]> {
  const rows = await db.ledgerEntry.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(200, Math.max(1, limit)),
    include: { account: { select: { kind: true, refId: true } } },
  });
  return rows.map((e) => ({
    id: e.id,
    at: e.createdAt.toISOString(),
    kind: e.account.kind as WalletKind,
    refId: e.account.refId,
    direction: e.direction,
    amountCents: e.amountCents,
    state: e.state,
    refType: e.refType,
    ref: e.refId,
    memo: e.memo,
  }));
}
