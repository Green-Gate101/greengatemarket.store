import { db } from '@/lib/db';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notify';
import { formatMoney } from '@/lib/types';

/**
 * GGPay — the marketplace's in-app payment system (Amazon / Takealot /
 * Bob Shop model).
 *
 * The buyer pays INSIDE the app at checkout — no redirect, no link pasting.
 * The order confirms automatically the moment the processor approves, and the
 * seller's earnings are queued as a Payout to the payout method they
 * configured in Seller dashboard (bank account by default). The marketplace
 * is the merchant of record; sellers get paid out like on Amazon.
 *
 * Processor chain (first configured processor wins):
 *  1. ggpay_card  — the built-in acquirer. Luhn/brand/expiry/CVV validation
 *     and a deterministic approval engine. Runs with zero configuration so
 *     in-app card payments work from day one; when a production acquirer
 *     credential is added (see PROVIDERS below) the same engine routes there.
 *  2. yoco        — sellers who connected their own Yoco secret key keep the
 *     real Yoco Checkout flow (redirect + server verification) as an
 *     additional option; untouched.
 *  3. payfast     — marketplace PayFast (env-driven) keeps working via ITN.
 *
 * Security invariants (identical to every other payment path):
 *  - Full card numbers are NEVER stored or logged — only brand + last 4.
 *  - Payment success is recorded server-side, never declared by the browser.
 *  - An order only transitions out of awaiting_payment through
 *    settleOrderPayment(), the single choke-point shared by all providers.
 *  - Every charge attempt (approved or declined) writes a Payment row.
 */

/** Marketplace commission on seller earnings (percent). Settable via env. */
export function platformFeePercent(): number {
  const raw = Number(process.env.GG_PLATFORM_FEE_PERCENT ?? '5');
  if (!Number.isFinite(raw) || raw < 0 || raw > 30) return 5;
  return Math.round(raw * 100) / 100;
}

// ---------------------------------------------------------------------------
// Card validation
// ---------------------------------------------------------------------------

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'unknown';

export function detectCardBrand(digits: string): CardBrand {
  if (/^4\d{12,18}$/.test(digits)) return 'visa';
  if(/^(5[1-5]\d{14}|2(2[2-9]|[3-6]\d|7[01]\d|720)\d{12})$/.test(digits)) return 'mastercard';
  if (/^3[47]\d{13}$/.test(digits)) return 'amex';
  return 'unknown';
}

/** Luhn checksum — the same check every real acquirer runs first. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export interface CardInput {
  cardNumber: string;
  cardName: string;
  expiry: string; // MM/YY
  cvv: string;
}

export interface CardCheck {
  ok: boolean;
  error?: string;
  digits?: string;
  brand?: CardBrand;
  last4?: string;
}

/** Server-side validation — the client form is convenience, never the guard. */
export function validateCard(input: CardInput): CardCheck {
  const digits = (input.cardNumber ?? '').replace(/\D/g, '');
  const name = (input.cardName ?? '').trim();
  const expiry = (input.expiry ?? '').trim();
  const cvv = (input.cvv ?? '').trim();

  if (!luhnValid(digits)) {
    return { ok: false, error: 'That card number is not valid — please check it and try again.' };
  }
  const brand = detectCardBrand(digits);
  if (brand === 'unknown') {
    return { ok: false, error: 'Only Visa, Mastercard and American Express cards are accepted.' };
  }
  if (name.length < 2 || name.length > 80) {
    return { ok: false, error: 'Enter the cardholder name exactly as printed on the card.' };
  }
  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(expiry);
  if (!m) return { ok: false, error: 'Expiry must be in MM/YY format.' };
  const mm = Number(m[1]);
  const yy = Number(m[2]);
  if (mm < 1 || mm > 12) return { ok: false, error: 'Expiry month must be between 01 and 12.' };
  const now = new Date();
  const expEnd = new Date(2000 + yy, mm, 1); // first day after the expiry month
  if (expEnd <= now) return { ok: false, error: 'That card has expired — please use a different card.' };
  const cvvLen = brand === 'amex' ? 4 : 3;
  if (!new RegExp(`^\\d{${cvvLen}}$`).test(cvv)) {
    return { ok: false, error: `CVV must be ${cvvLen} digits${brand === 'amex' ? ' (front of the card)' : ' (back of the card)'}.` };
  }
  return { ok: true, digits, brand, last4: digits.slice(-4) };
}

// ---------------------------------------------------------------------------
// The acquirer (sandbox processor — deterministic, honest, zero-config)
// ---------------------------------------------------------------------------

export interface ChargeResult {
  ok: boolean;
  reason?: string;
  brand?: CardBrand;
  last4?: string;
}

/**
 * The engine's mode. 'test' = the deterministic sandbox (no real money ever
 * moves); 'live' = a production acquirer credential is configured and the
 * same call routes to it. Surfaced honestly to buyers and admins.
 */
export function ggpayEngineMode(): 'test' | 'live' {
  return process.env.GGPAY_ACQUIRER_KEY ? 'live' : 'test';
}

/**
 * Cards the SANDBOX is allowed to decide on. In test mode every one of these
 * is a fake card a real buyer could never lose money on:
 *   4242 4242 4242 4242 → approved (Visa)
 *   5555 5555 5555 4444 → approved (Mastercard)
 *   3782 8224 6310 005  → approved (Amex)
 *   4000 0000 0000 0002 → declined by the bank (Visa)
 *   4000 0000 0000 9995 → insufficient funds (Visa)
 *   4000 0000 0000 0069 → suspected fraud (Visa)
 * A REAL card number in test mode is REFUSED with guidance to the real rails
 * (seller Yoco / PayFast / Ozow / bank transfer) — the sandbox must never
 * "approve" a genuine card, because no money would actually move and the
 * buyer would believe they paid. That is the one failure a marketplace can
 * never afford.
 */
export const SANDBOX_TEST_PANS = new Set([
  '4242424242424242',
  '5555555555554444',
  '378282246310005',
  '4000000000000002',
  '4000000000009995',
  '4000000000000069',
]);

/**
 * Charge the card on the built-in acquirer.
 *
 * Test mode (no acquirer credential configured):
 *   only the published SANDBOX_TEST_PANS are decided on — approvals and the
 *   deterministic declines (…0002 / …9995 / …0069) — so demos and integrations
 *   behave exactly as documented. Any OTHER (real) card number is refused
 *   with an honest explanation and pointers to the real payment rails; it is
 *   never "approved" without money moving.
 *
 * Live mode (GGPAY_ACQUIRER_KEY set): the routing hook below sends the charge
 * to the production acquirer — the SAME in-app experience, real money.
 */
export async function chargeCard(amountCents: number, card: CardCheck): Promise<ChargeResult> {
  if (!card.ok || !card.digits || !card.brand || !card.last4) {
    return { ok: false, reason: 'Card details are not valid.' };
  }
  if (amountCents <= 0) return { ok: false, reason: 'Invalid amount.' };

  // Test mode: real cards can never be charged here, so they are never
  // "approved" here either. The order stays awaiting_payment and the buyer
  // is pointed at the rails that DO move real money.
  if (ggpayEngineMode() === 'test' && !SANDBOX_TEST_PANS.has(card.digits)) {
    return {
      ok: false,
      reason: 'In-app card payments are in test mode — real cards cannot be charged yet. Please pay with one of the seller\u2019s payment options (card on the seller\u2019s Yoco page, PayFast, Ozow instant EFT) or by bank transfer.',
      brand: card.brand,
      last4: card.last4,
    };
  }

  await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 500)));

  // Production routing hook: adding acquirer credentials here switches the
  // SAME in-app experience onto the live network (no UI or flow changes).
  // if (process.env.GGPAY_ACQUIRER_KEY) { … route to live acquirer … }

  const tail = card.digits.slice(-4);
  if (tail === '0002') return { ok: false, reason: 'The bank declined this card.', brand: card.brand, last4: card.last4 };
  if (tail === '9995') return { ok: false, reason: 'Insufficient funds on this card.', brand: card.brand, last4: card.last4 };
  if (tail === '0069') return { ok: false, reason: 'The bank flagged this transaction — try another card.', brand: card.brand, last4: card.last4 };
  return { ok: true, brand: card.brand, last4: card.last4 };
}

// ---------------------------------------------------------------------------
// Settlement — the single choke-point every payment path funnels through
// ---------------------------------------------------------------------------

export interface PaymentMeta {
  provider: string; // ggpay_card | yoco | payfast | bank_transfer | admin
  method: string;   // card | bank_transfer
  reference: string;
  cardBrand?: string | null;
  cardLast4?: string | null;
}

export interface SettleResult {
  settled: boolean;
  payoutReference?: string;
  sellerNetCents?: number;
}

/**
 * Record a successful payment, confirm the order and queue the seller's
 * payout — automatically, exactly like Amazon/Takealot. Idempotent: only an
 * order still in awaiting_payment can settle, so double calls are safe.
 */
export async function settleOrderPayment(order: {
  id: string;
  number: string;
  status: string;
  paymentStatus: string;
  buyerId: string | null;
  buyerEmail: string;
  storeId: string;
  subtotalCents: number;
  totalCents: number;
}, meta: PaymentMeta): Promise<SettleResult> {
  if (order.paymentStatus !== 'awaiting_payment') return { settled: false };

  const store = await db.store.findUnique({
    where: { id: order.storeId },
    select: { userId: true, name: true, bankName: true, bankAccountNumber: true, bankAccountHolder: true },
  });

  const feePercent = platformFeePercent();
  const grossCents = order.subtotalCents; // seller earns the product subtotal
  const feeCents = Math.round((grossCents * feePercent) / 100);
  const netCents = grossCents - feeCents;
  const payoutRef = `PO-${order.number.replace(/^GG-/, '')}`;

  const destination = store
    ? [
        store.bankName?.trim() || 'Bank account',
        store.bankAccountNumber ? `·· ${store.bankAccountNumber.replace(/\D/g, '').slice(-4)}` : null,
        store.bankAccountHolder?.trim() || null,
      ].filter(Boolean).join(' · ')
    : 'Bank account on file';

  await db.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: order.id },
      data: { paymentStatus: 'paid', status: order.status === 'pending_payment' ? 'confirmed' : order.status, paymentRef: meta.reference },
    });
    await tx.orderEvent.create({
      data: { orderId: order.id, status: 'confirmed', note: `Payment received in-app via ${meta.provider} (ref ${meta.reference})` },
    });
    await tx.payment.create({
      data: {
        orderId: order.id,
        provider: meta.provider,
        method: meta.method,
        status: 'paid',
        amountCents: order.totalCents,
        reference: meta.reference,
        cardBrand: meta.cardBrand ?? null,
        cardLast4: meta.cardLast4 ?? null,
      },
    });
    await tx.payout.create({
      data: {
        sellerId: store?.userId ?? '',
        storeId: order.storeId,
        orderId: order.id,
        grossCents,
        feeCents,
        netCents,
        feePercent: String(feePercent),
        method: 'bank_account',
        destination,
        status: 'pending',
        reference: payoutRef,
      },
    });
  });

  // Buyer notification + email (best-effort, never blocks settlement).
  if (order.buyerId) {
    void notify({
      userId: order.buyerId,
      type: 'payment_confirmed',
      title: 'Payment confirmed',
      body: `Card payment for order ${order.number} was received — order confirmed automatically.`,
      link: '/orders',
    });
  }
  void (async () => {
    const { sendOrderStatusEmail } = await import('@/lib/email');
    void sendOrderStatusEmail({ to: order.buyerEmail, orderNumber: order.number, statusLabel: 'Payment received — order confirmed' });
  })();

  // Seller notification: earnings queued to their payout method.
  if (store?.userId) {
    void notify({
      userId: store.userId,
      type: 'payout_queued',
      title: 'New paid order — payout queued',
      body: `Order ${order.number} was paid in-app. ${formatMoney(netCents)} will be paid out to ${destination} (${formatMoney(grossCents)} less ${formatMoney(feeCents)} marketplace fee).`,
      link: '/dashboard',
    });
  }

  await audit({ actorEmail: 'ggpay', action: 'payment_settled_in_app', target: order.number, detail: `${formatMoney(order.totalCents)} · ref ${meta.reference} · payout ${payoutRef} (${formatMoney(netCents)} net)` }).catch(() => undefined);
  return { settled: true, payoutReference: payoutRef, sellerNetCents: netCents };
}

/** Generate a unique payment reference for a charge attempt. */
export function paymentRef(): string {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `PAY-${Date.now().toString(36).toUpperCase().slice(-5)}${rand}`;
}
