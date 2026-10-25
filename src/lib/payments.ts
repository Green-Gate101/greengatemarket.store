import type { Order } from '@prisma/client';

/**
 * Payment provider abstraction (spec #70).
 *
 * Green Gate currently operates a REAL bank-transfer (EFT) flow — the dominant
 * low-cost payment method for South African marketplaces — with the provider
 * interface kept open for further gateways as merchant credentials are supplied. Payment success is NEVER declared by the browser: an order
 * only becomes a confirmed sale after the seller/administrator records the
 * money as received, which is an authenticated server-side action.
 *
 * To add a gateway: implement PaymentProvider and register it in `providers`.
 */

export interface PaymentIntent {
  provider: string;
  reference: string;
  instructionsHtml: string;
  amountCents: number;
  currency: string;
}

export interface PaymentProvider {
  readonly id: string;
  readonly label: string;
  createPayment(order: { number: string; totalCents: number; currency: string }): Promise<PaymentIntent>;
  verifyPayment(paymentRef: string): Promise<{ paid: boolean }>;
}

/** Bank transfer / EFT — real manual reconciliation flow. */
export class BankTransferProvider implements PaymentProvider {
  readonly id = 'bank_transfer';
  readonly label = 'Bank transfer (EFT)';

  async createPayment(order: { number: string; totalCents: number; currency: string }): Promise<PaymentIntent> {
    const reference = order.number;
    const amount = (order.totalCents / 100).toFixed(2);
    return {
      provider: this.id,
      reference,
      amountCents: order.totalCents,
      currency: order.currency,
      instructionsHtml: [
        `<p>Pay <strong>${order.currency} ${amount}</strong> using reference <strong>${reference}</strong>.</p>`,
        '<p>Choose how to pay from <em>My orders</em> in Green Gate — the seller’s card / instant-EFT options and, where the seller has added them, their bank details for EFT. Once your payment is verified (or the seller confirms your transfer), your order moves to <em>Payment confirmed</em>.</p>',
      ].join(''),
    };
  }

  async verifyPayment(_paymentRef: string): Promise<{ paid: boolean }> {
    // Bank transfers reconcile manually (seller/admin confirms receipt);
    // there is no real-time gateway to query — this is honest by design.
    return { paid: false };
  }
}

/** Where an EFT for an order goes: the seller's own bank account (the seller
 *  confirms receipt). Shown ONLY to that order's buyer while it awaits
 *  payment — without it "pay by bank transfer" was an instruction nobody
 *  could follow. */
export interface EftDetails {
  bankName: string;
  accountHolder: string;
  accountNumber: string;
  branchCode: string | null;
  accountType: string | null;
}

export function eftDetailsFor(
  store: { bankName?: string | null; bankAccountHolder?: string | null; bankAccountNumber?: string | null; bankBranchCode?: string | null; bankAccountType?: string | null },
  order: { status: string; paymentStatus: string },
): EftDetails | null {
  if (order.status !== 'pending_payment' || order.paymentStatus !== 'awaiting_payment') return null;
  if (!store.bankName?.trim() || !store.bankAccountNumber?.trim() || !store.bankAccountHolder?.trim()) return null;
  return {
    bankName: store.bankName.trim(),
    accountHolder: store.bankAccountHolder.trim(),
    accountNumber: store.bankAccountNumber.trim(),
    branchCode: store.bankBranchCode?.trim() || null,
    accountType: store.bankAccountType?.trim() || null,
  };
}

/** Store columns eftDetailsFor reads (for Prisma selects). */
export const EFT_STORE_SELECT = {
  bankName: true, bankAccountHolder: true, bankAccountNumber: true, bankBranchCode: true, bankAccountType: true,
} as const;

const providers: Record<string, PaymentProvider> = {
  bank_transfer: new BankTransferProvider(),
};

export function getPaymentProvider(id: string | null | undefined): PaymentProvider {
  return providers[id ?? 'bank_transfer'] ?? providers.bank_transfer;
}

export function paymentLabel(id: string | null | undefined): string {
  return getPaymentProvider(id).label;
}

/** Validated state machine for order lifecycle transitions (spec #22). */
const TRANSITIONS: Record<string, string[]> = {
  pending_payment: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'packed', 'shipped', 'cancelled', 'refunded'],
  processing: ['packed', 'ready_for_collection', 'shipped', 'cancelled', 'returned'],
  packed: ['ready_for_collection', 'shipped', 'returned'],
  ready_for_collection: ['delivered', 'returned'],
  shipped: ['in_transit', 'returned'],
  in_transit: ['out_for_delivery', 'delivered', 'returned'],
  out_for_delivery: ['delivered', 'returned'],
  delivered: ['returned', 'refunded'],
  cancelled: [],
  returned: ['refunded'],
  refunded: [],
};

export function canTransition(from: string, to: string): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Orders whose money went back to the buyer (or is due back). Their seller
 * payout is ON HOLD: it must never be marked processing or paid, or the
 * marketplace would pay the seller for money it returned.
 */
export const PAYOUT_HOLD_ORDER_STATUSES = ['cancelled', 'refunded', 'returned'];

export function payoutOnHold(orderStatus: string | null | undefined): boolean {
  return PAYOUT_HOLD_ORDER_STATUSES.includes(orderStatus ?? '');
}

export type OrderRecord = Order;
