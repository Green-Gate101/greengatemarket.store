import type { Order } from '@prisma/client';

/**
 * Payment provider abstraction (spec #70).
 *
 * Green Gate currently operates a REAL bank-transfer (EFT) flow — the dominant
 * low-cost payment method for South African marketplaces — with the provider
 * interface kept open for PayFast/Stripe/Yoco as soon as merchant credentials
 * are supplied. Payment success is NEVER declared by the browser: an order
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
        '<p>Banking details are emailed to you with the order confirmation. Once your transfer reflects, the seller confirms receipt and your order moves to <em>Payment confirmed</em>.</p>',
      ].join(''),
    };
  }

  async verifyPayment(_paymentRef: string): Promise<{ paid: boolean }> {
    // Bank transfers reconcile manually (seller/admin confirms receipt);
    // there is no real-time gateway to query — this is honest by design.
    return { paid: false };
  }
}

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

export type OrderRecord = Order;
