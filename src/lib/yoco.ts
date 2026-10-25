import { trackApiUsage } from '@/lib/usage';
import { db } from '@/lib/db';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notify';
import { ggpaySandboxAllowed } from '@/lib/ggpay';
import { decryptSecret } from '@/lib/secret-box';

/**
 * Yoco Checkout API — in-system card payments for sellers.
 *
 * Sellers connect their OWN Yoco account by pasting their secret key
 * (Yoco Business Portal → Sell Online → Payment Gateway) into Seller dashboard →
 * Payment details. The key is AES-256-GCM encrypted at rest (secret-box) and
 * never leaves the server. At checkout the marketplace creates a real Yoco
 * Checkout session for the exact order total; the buyer pays by card
 * (Mastercard & Visa accepted) on Yoco's hosted page, and the marketplace
 * confirms the order only after the checkout session verifies as paid —
 * via the return handler or the payment.succeeded webhook, never the
 * browser alone.
 *
 * Endpoint contract (probed live 2026-10-18 + vendor reference):
 *   POST https://payments.yoco.com/api/checkouts      { amount(cents), currency, successUrl, cancelUrl, failureUrl, metadata } → { id, redirectUrl }
 *   GET  https://payments.yoco.com/api/checkouts/:id  → checkout object (auth required; 401 on bad key)
 *
 * Every function is fail-safe: on any error it resolves null and the caller
 * falls back to the existing bank-transfer / payment-link flow. Checkout
 * NEVER blocks because of the payment gateway.
 */

const YOCO_BASE = 'https://payments.yoco.com/api/checkouts';
const TIMEOUT_MS = 12_000;

/** Yoco secret keys look like sk_live_xxx / sk_test_xxx. */
export function yocoKeyLooksValid(key: string): boolean {
  return /^sk_(live|test)_[A-Za-z0-9_-]{10,}$/.test(key.trim());
}

/**
 * Can this Yoco key take REAL payments here? Live keys always; test keys
 * only where sandbox settlement is allowed (local dev / an isolated test
 * deployment). On the live marketplace a test key's checkout "succeeds" with
 * Yoco's public test cards while no money moves — that order must never
 * confirm.
 */
export function yocoKeyUsable(secret: string | null | undefined): boolean {
  const key = (secret ?? '').trim();
  if (key.startsWith('sk_live_')) return true;
  return key.startsWith('sk_test_') && ggpaySandboxAllowed();
}

export interface YocoSessionInput {
  amountCents: number;
  orderNumber: string;
  storeName: string;
  successUrl: string;
  cancelUrl: string;
  failureUrl?: string;
}

export interface YocoSession {
  id: string;
  redirectUrl: string;
}

/** Create a hosted card-checkout session. Returns null on any failure. */
export async function yocoCreateCheckout(secretKey: string, input: YocoSessionInput): Promise<YocoSession | null> {
  try {
    trackApiUsage('yoco');
    const res = await fetch(YOCO_BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: Math.round(input.amountCents),
        currency: 'ZAR',
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        failureUrl: input.failureUrl ?? input.cancelUrl,
        metadata: {
          transactionId: input.orderNumber,
          store: input.storeName,
          marketplace: 'Green Gate Marketplace',
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('yoco create failed:', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = (await res.json()) as { id?: string; redirectUrl?: string };
    if (!data.id || !data.redirectUrl) {
      console.error('yoco create: missing id/redirectUrl in response');
      return null;
    }
    return { id: data.id, redirectUrl: data.redirectUrl };
  } catch (e) {
    console.error('yoco create error:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Retrieve a checkout session and determine whether it was PAID.
 * Defensive about the response shape (Yoco evolves it): checks a terminal
 * success `status` or a successful entry in a `payments` collection.
 * Anything unrecognised resolves { paid: false } — an order is only ever
 * confirmed on positive proof, never on ambiguity.
 */
export async function yocoRetrieveCheckout(secretKey: string, checkoutId: string): Promise<{ paid: boolean; status: string; amountCents: number | null } | null> {
  try {
    trackApiUsage('yoco');
    const res = await fetch(`${YOCO_BASE}/${encodeURIComponent(checkoutId)}`, {
      headers: { Authorization: `Bearer ${secretKey.trim()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('yoco retrieve failed:', res.status);
      return null;
    }
    const data = (await res.json()) as {
      status?: string;
      amount?: number | string;
      payments?: Array<{ status?: string } | string>;
    };
    const SUCCESS = new Set(['succeeded', 'success', 'paid', 'completed', 'complete', 'captured']);
    let paid = false;
    const status = String(data.status ?? 'unknown');
    if (SUCCESS.has(status.toLowerCase())) paid = true;
    if (!paid && Array.isArray(data.payments)) {
      paid = data.payments.some((p) => {
        const ps = typeof p === 'string' ? p : String(p?.status ?? '');
        return SUCCESS.has(ps.toLowerCase());
      });
    }
    // The paid amount (cents) when Yoco reports it — callers bind it to the
    // order total so a cheap checkout on the same account can never confirm
    // an expensive order.
    const rawAmount = typeof data.amount === 'string' ? Number(data.amount) : data.amount;
    const amountCents = typeof rawAmount === 'number' && Number.isFinite(rawAmount) && rawAmount > 0 ? Math.round(rawAmount) : null;
    return { paid, status, amountCents };
  } catch (e) {
    console.error('yoco retrieve error:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Confirm an order's payment using EXACTLY the same state transition the
 * PayFast ITN webhook and the admin "Confirm payment" action use — payment
 * success is never declared by the browser. Atomic: the updateMany claim
 * only ever transitions an order still in awaiting_payment (and never a
 * cancelled/refunded one), so the return handler and the webhook can race
 * without double-confirming. Records a Payment row like every other rail.
 */
export async function confirmYocoPayment(order: {
  id: string;
  number: string;
  status: string;
  paymentStatus: string;
  buyerId: string | null;
  buyerEmail: string;
  totalCents: number;
}, paymentRef: string): Promise<boolean> {
  // Atomic claim: exactly one caller wins; a cancelled/refunded order can
  // never be revived through this path.
  const claim = await db.order.updateMany({
    where: { id: order.id, paymentStatus: 'awaiting_payment', status: { notIn: ['cancelled', 'refunded'] } },
    data: { paymentStatus: 'paid', paymentRef },
  });
  if (claim.count === 0) return false;

  await db.$transaction([
    // Status upgrade: only a still-pending order becomes confirmed; an order
    // already further along keeps its state.
    db.order.updateMany({
      where: { id: order.id, status: 'pending_payment' },
      data: { status: 'confirmed' },
    }),
    db.orderEvent.create({ data: { orderId: order.id, status: 'confirmed', note: `Yoco card payment received (ref ${paymentRef})` } }),
    db.payment.create({
      data: {
        orderId: order.id,
        provider: 'yoco',
        method: 'card',
        status: 'paid',
        amountCents: order.totalCents,
        reference: paymentRef,
      },
    }),
  ]);
  if (order.buyerId) {
    void notify({
      userId: order.buyerId,
      type: 'payment_confirmed',
      title: 'Payment confirmed',
      body: `Card payment for order ${order.number} was received via Yoco. Your order is being prepared.`,
      link: '/orders',
    });
  }
  void (async () => {
    const { sendOrderStatusEmail } = await import('@/lib/email');
    void sendOrderStatusEmail({ to: order.buyerEmail, orderNumber: order.number, statusLabel: 'Card payment received via Yoco — order confirmed' });
  })();
  await audit({ actorEmail: 'yoco-checkout', action: 'payment_confirmed_yoco', target: order.number, detail: `ref ${paymentRef}` }).catch(() => undefined);
  return true;
}

/** Does this store offer a usable Yoco card checkout right now? (Presence
 *  flag for the order views — the key itself never leaves the server.) */
export function yocoStoreReady(store: { payoutProvider?: string | null; yocoSecretKey?: string | null }): boolean {
  if (!['yoco', 'mastercard'].includes(store.payoutProvider ?? '') || !store.yocoSecretKey) return false;
  return yocoKeyUsable(decryptSecret(store.yocoSecretKey));
}

/** Where the buyer lands after Yoco (hash-routed SPA view). */
export function yocoOrdersRedirect(baseUrl: string, state: 'success' | 'pending' | 'cancelled' | 'unavailable'): string {
  return `${baseUrl}/#/orders?yoco=${state}`;
}
