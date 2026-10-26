import { createHash, randomBytes } from 'crypto';
import { db } from '@/lib/db';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notify';
import { AuthError } from '@/lib/auth';
import { yocoCreateCheckout, yocoKeyAccepted, yocoKeyUsable, yocoRetrieveCheckout } from '@/lib/yoco';

/**
 * Seller subscriptions — sellers pay Green Gate to sell on the marketplace.
 *
 *  - Plans: monthly (R499) and yearly (R6 999), prepaid through Green Gate's
 *    own Yoco account (YOCO_PLATFORM_SECRET_KEY). Prices can be changed
 *    without code via SELLER_PLAN_MONTHLY_CENTS / SELLER_PLAN_YEARLY_CENTS.
 *  - 30-day free trial, once, starting when the store is approved (existing
 *    stores got theirs when this feature shipped).
 *  - Free access: stores owned by the administrator, and stores the
 *    administrator grants it to in the admin console (billingExempt).
 *  - Store.accessUntil = the later of trial end and paid-until. While it is
 *    in the future (or the store is exempt) the store sells; afterwards its
 *    store page and products are hidden everywhere buyers look and its
 *    listing tools are locked until it pays. Nothing is deleted: paying
 *    brings everything back instantly. Already-paid buyer orders can always
 *    be fulfilled.
 *  - A payment only counts after Green Gate's server confirms it with Yoco
 *    (checkout retrieved by the id stored on the payment, amount must match)
 *    — never because a browser says so. The confirmation is an atomic claim,
 *    so the return page, the dashboard re-check and the daily job can race
 *    without crediting a payment twice.
 */

export type Plan = 'monthly' | 'yearly';
export const PLANS: Plan[] = ['monthly', 'yearly'];
export const PLAN_MONTHS: Record<Plan, number> = { monthly: 1, yearly: 12 };
export const TRIAL_DAYS = 30;
const DAY = 86_400_000;

function envCents(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v >= 100 && v <= 100_000_000 ? v : fallback;
}

/** Price in cents (R499 / R6 999 unless changed in the environment). */
export function planPriceCents(plan: Plan): number {
  return plan === 'yearly' ? envCents('SELLER_PLAN_YEARLY_CENTS', 699_900) : envCents('SELLER_PLAN_MONTHLY_CENTS', 49_900);
}

/** "R499" / "R6 999" — whole rands for prices shown to sellers. */
export function randLabel(cents: number): string {
  const whole = Math.floor(Math.abs(cents) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  const c = Math.abs(cents) % 100;
  return `${cents < 0 ? '-' : ''}R${whole}${c ? `,${String(c).padStart(2, '0')}` : ''}`;
}

export function isPlan(v: unknown): v is Plan {
  return v === 'monthly' || v === 'yearly';
}

/** Everything a subscription includes — shown to sellers before they pay. */
export const SUBSCRIPTION_FEATURES: string[] = [
  'Your own store page with your logo and banner, findable in search',
  'Unlimited product listings — up to 8 photos each, sizes and stock per size',
  'Automatic white studio backgrounds for your product photos',
  'Buyers pay you directly through your own PayFast, Ozow or Yoco account — Green Gate takes no commission on those sales',
  'Live The Courier Guy delivery quotes at checkout, charged to the buyer',
  'Order management with buyer email and in-app updates at every step',
  'Sales analytics: revenue, orders, units, views and best sellers',
  'Your products in Green Gate search and personalised recommendations',
  'Protection for honest sellers: AI-generated and counterfeit listings are refused',
  'Direct in-app messages with the Green Gate team',
];

/** Columns every access decision needs. */
export const BILLING_SELECT = {
  status: true,
  billingExempt: true,
  accessUntil: true,
  trialEndsAt: true,
  paidUntil: true,
  subscriptionPlan: true,
} as const;

/** Prisma filter: a store that may sell right now (use inside `store: {…}`). */
export function sellingStoreWhere(now: Date = new Date()) {
  return {
    status: 'active',
    OR: [{ billingExempt: true }, { accessUntil: { gt: now } }],
  };
}

type DateLike = Date | string | null | undefined;
const ts = (d: DateLike): number => (d ? new Date(d).getTime() : 0);

/** Same rule as sellingStoreWhere, for a store row already in hand. */
export function storeCanSell(store: { status: string; billingExempt?: boolean | null; accessUntil?: DateLike }, now: Date = new Date()): boolean {
  if (store.status !== 'active') return false;
  if (store.billingExempt) return true;
  return ts(store.accessUntil) > now.getTime();
}

export type AccessState = 'free' | 'trial' | 'paid' | 'expired' | 'not_active';

export interface StoreAccess {
  state: AccessState;
  accessUntil: string | null;
  trialEndsAt: string | null;
  paidUntil: string | null;
  plan: Plan | null;
  daysLeft: number | null;
  canSell: boolean;
  /** Seller tools (listings, store profile, analytics, payment settings) unlocked. */
  toolsUnlocked: boolean;
}

export function storeAccess(store: {
  status: string;
  billingExempt?: boolean | null;
  accessUntil?: DateLike;
  trialEndsAt?: DateLike;
  paidUntil?: DateLike;
  subscriptionPlan?: string | null;
}, now: Date = new Date()): StoreAccess {
  const iso = (d: DateLike) => (d ? new Date(d).toISOString() : null);
  const until = ts(store.accessUntil);
  let state: AccessState;
  if (store.status !== 'active') state = 'not_active';
  else if (store.billingExempt) state = 'free';
  else if (until > now.getTime()) state = ts(store.paidUntil) > now.getTime() ? 'paid' : 'trial';
  else state = 'expired';
  return {
    state,
    accessUntil: iso(store.accessUntil),
    trialEndsAt: iso(store.trialEndsAt),
    paidUntil: iso(store.paidUntil),
    plan: isPlan(store.subscriptionPlan) ? store.subscriptionPlan : null,
    daysLeft: state === 'trial' || state === 'paid' ? Math.max(0, Math.ceil((until - now.getTime()) / DAY)) : null,
    canSell: state === 'free' || state === 'trial' || state === 'paid',
    // A store still under review keeps its (empty) tools; only a lapsed
    // subscription locks them.
    toolsUnlocked: state !== 'expired',
  };
}

/** Data that starts the one-time 30-day trial. */
export function trialStartData(now: Date = new Date()) {
  const end = new Date(now.getTime() + TRIAL_DAYS * DAY);
  return { trialEndsAt: end, accessUntil: end };
}

/** Calendar months, clamped to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: Date, months: number): Date {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + months);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}

export const SUBSCRIPTION_LAPSED_MESSAGE =
  'Your Green Gate subscription has ended, so your store and products are paused. Renew it in your seller dashboard to manage your store again.';

/**
 * Seller tools (listing, editing, store profile, analytics, payment settings)
 * need a running subscription. Throws 402 with a clear message otherwise;
 * order fulfilment, messages and billing stay open regardless.
 */
export async function requireSellerTools(userId: string): Promise<void> {
  const store = await db.store.findUnique({ where: { userId }, select: BILLING_SELECT });
  if (store && !storeAccess(store).toolsUnlocked) throw new AuthError(SUBSCRIPTION_LAPSED_MESSAGE, 402);
}

/** Green Gate's own Yoco key (live keys anywhere; test keys only where sandbox is allowed). */
export function platformYocoKey(): string | null {
  const key = String(process.env.YOCO_PLATFORM_SECRET_KEY ?? '').trim();
  return key && yocoKeyUsable(key) ? key : null;
}

/**
 * Are subscription card payments really on? For /api/health, the System
 * monitor and the admin console. Checks the key is set and is a live key,
 * then that Yoco accepts it (a lookup that creates nothing, remembered for
 * 10 minutes — 1 minute when Yoco could not be reached). Never shows the key.
 */
let keyCheck: { at: number; fingerprint: string; accepted: boolean | null } | null = null;
let keyCheckRunning: Promise<boolean | null> | null = null;
export async function subscriptionPaymentsStatus(): Promise<{ ok: boolean; detail: string }> {
  const raw = String(process.env.YOCO_PLATFORM_SECRET_KEY ?? '').trim();
  if (!raw) return { ok: false, detail: 'OFF — YOCO_PLATFORM_SECRET_KEY is not set, so sellers cannot pay their subscription (stores keep selling until their trial or paid time ends)' };
  const key = platformYocoKey();
  if (!key) return { ok: false, detail: 'OFF — YOCO_PLATFORM_SECRET_KEY is not a live Yoco secret key (it must start with sk_live_)' };
  const fingerprint = createHash('sha256').update(key).digest('hex');
  const fresh = keyCheck && keyCheck.fingerprint === fingerprint && Date.now() - keyCheck.at < (keyCheck.accepted === null ? 60_000 : 600_000);
  if (!fresh) {
    keyCheckRunning ??= yocoKeyAccepted(key).finally(() => { keyCheckRunning = null; });
    keyCheck = { at: Date.now(), fingerprint, accepted: await keyCheckRunning };
  }
  if (keyCheck!.accepted === false) return { ok: false, detail: 'OFF — Yoco rejected Green Gate’s secret key (check YOCO_PLATFORM_SECRET_KEY)' };
  if (keyCheck!.accepted === null) return { ok: true, detail: 'ON — live Yoco key set (Yoco could not be reached to re-confirm it just now)' };
  return { ok: true, detail: 'ON — sellers pay by card on Yoco; Yoco accepted Green Gate’s live key' };
}

export function newSubscriptionReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `SUB-${out}`;
}

/** Start a Yoco checkout for a plan. Throws AuthError with a clear message on refusal. */
export async function startSubscriptionCheckout(params: { userId: string; plan: Plan; baseUrl: string }): Promise<{ redirectUrl: string; reference: string }> {
  const store = await db.store.findUnique({
    where: { userId: params.userId },
    select: { id: true, name: true, user: { select: { role: true } }, ...BILLING_SELECT },
  });
  if (!store) throw new AuthError('Create your store first.', 404);
  if (store.status !== 'active') throw new AuthError('Your store must be approved before you can subscribe.', 409);
  if (store.billingExempt || store.user.role === 'ADMIN') throw new AuthError('Your store has free access — there is nothing to pay.', 409);
  const key = platformYocoKey();
  if (!key) throw new AuthError('Subscription payments are not switched on yet — please message Green Gate from your dashboard.', 503);

  const amountCents = planPriceCents(params.plan);
  const payment = await db.subscriptionPayment.create({
    data: { storeId: store.id, plan: params.plan, amountCents, status: 'pending', reference: newSubscriptionReference() },
  });
  const base = params.baseUrl.replace(/\/$/, '');
  const back = `${base}/api/seller/subscription/return?ref=${payment.reference}`;
  const checkout = await yocoCreateCheckout(key, {
    amountCents,
    orderNumber: payment.reference,
    storeName: store.name,
    successUrl: back,
    cancelUrl: `${base}/#/dashboard?billing=cancelled`,
    failureUrl: `${back}&failed=1`,
  });
  if (!checkout) {
    await db.subscriptionPayment.update({ where: { id: payment.id }, data: { status: 'failed' } });
    throw new AuthError('Yoco could not start the payment right now — please try again in a moment.', 502);
  }
  await db.subscriptionPayment.update({ where: { id: payment.id }, data: { yocoCheckoutId: checkout.id } });
  await audit({ actorId: params.userId, action: 'subscription_checkout_started', target: payment.reference, detail: `${params.plan} · ${amountCents} cents · ${store.name}` }).catch(() => undefined);
  return { redirectUrl: checkout.redirectUrl, reference: payment.reference };
}

/**
 * Credit a confirmed payment exactly once: the next period starts when the
 * current access ends (paying early during the trial or a paid period adds
 * time after it), or now if access had already lapsed.
 */
export async function settleSubscriptionPayment(paymentId: string, now: Date = new Date()): Promise<boolean> {
  const result = await db.$transaction(async (tx) => {
    const claim = await tx.subscriptionPayment.updateMany({ where: { id: paymentId, status: 'pending' }, data: { status: 'paid', paidAt: now } });
    if (claim.count === 0) return null;
    const pay = await tx.subscriptionPayment.findUnique({
      where: { id: paymentId },
      include: { store: { select: { id: true, name: true, userId: true, accessUntil: true } } },
    });
    if (!pay) return null;
    // Two different payments for one store can be confirmed at the same
    // moment (two tabs, the return page and the dashboard re-check). The
    // store's date only moves from the value just read, so each payment adds
    // its own period; if another payment moved it first, read it again.
    let before = pay.store.accessUntil;
    for (let attempt = 0; ; attempt++) {
      const current = before && before.getTime() > now.getTime() ? before : now;
      const end = addMonths(current, PLAN_MONTHS[isPlan(pay.plan) ? pay.plan : 'monthly']);
      const moved = await tx.store.updateMany({ where: { id: pay.storeId, accessUntil: before }, data: { paidUntil: end, accessUntil: end, subscriptionPlan: pay.plan, billingNotice: null } });
      if (moved.count === 1) {
        await tx.subscriptionPayment.update({ where: { id: paymentId }, data: { periodStart: current, periodEnd: end } });
        return { pay, end };
      }
      // Rolls the claim back too: the payment stays pending and is credited on the next check.
      if (attempt >= 4) throw new Error('store access date kept changing — will retry');
      before = (await tx.store.findUnique({ where: { id: pay.storeId }, select: { accessUntil: true } }))?.accessUntil ?? null;
    }
  });
  if (!result) return false;
  const { pay, end } = result;
  const until = end.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });
  void notify({
    userId: pay.store.userId,
    type: 'subscription',
    title: 'Subscription payment received',
    body: `Thank you — your ${pay.plan} subscription for “${pay.store.name}” is paid until ${until} (ref ${pay.reference}).`,
    link: '/dashboard',
  });
  await audit({ actorEmail: 'yoco-subscription', action: 'subscription_paid', target: pay.reference, detail: `${pay.store.name} · ${pay.plan} · ${pay.amountCents} cents · until ${end.toISOString()}` }).catch(() => undefined);
  return true;
}

const FAILED_STATUSES = new Set(['failed', 'cancelled', 'canceled', 'expired', 'abandoned']);

/**
 * Ask Yoco about a pending payment and settle it on positive proof only:
 * the checkout stored on THIS payment must report paid with exactly this
 * amount (no amount reported = not proven). Never trusts browser input.
 */
export async function verifySubscriptionPayment(payment: { id: string; reference: string; status: string; amountCents: number; yocoCheckoutId: string | null }): Promise<'paid' | 'pending' | 'failed' | 'unavailable'> {
  if (payment.status === 'paid') return 'paid';
  if (payment.status !== 'pending') return 'failed';
  const key = platformYocoKey();
  if (!key) return 'unavailable';
  if (!payment.yocoCheckoutId) return 'failed';
  const r = await yocoRetrieveCheckout(key, payment.yocoCheckoutId);
  if (!r) return 'unavailable';
  if (r.paid) {
    if (r.amountCents !== payment.amountCents) {
      await audit({ actorEmail: 'yoco-subscription', action: 'subscription_amount_mismatch', target: payment.reference, detail: `expected ${payment.amountCents}, Yoco reported ${r.amountCents ?? 'no amount'}` }).catch(() => undefined);
      return 'pending';
    }
    // A busy database (another payment of this store being credited at the
    // same moment) gets one more try; if that fails too the payment stays
    // pending and the next check credits it — never lost, never doubled.
    await settleSubscriptionPayment(payment.id).catch(async () => {
      await new Promise((r) => setTimeout(r, 400));
      await settleSubscriptionPayment(payment.id);
    });
    return 'paid';
  }
  if (FAILED_STATUSES.has(r.status.toLowerCase())) {
    await db.subscriptionPayment.updateMany({ where: { id: payment.id, status: 'pending' }, data: { status: 'failed' } });
    return 'failed';
  }
  return 'pending';
}

/** Re-check a store's recent pending payments (dashboard load). At most 3 Yoco calls, side by side (one timeout at most). */
export async function verifyRecentPendingPayments(storeId: string): Promise<void> {
  if (!platformYocoKey()) return;
  const pending = await db.subscriptionPayment.findMany({
    where: { storeId, status: 'pending', yocoCheckoutId: { not: null }, createdAt: { gt: new Date(Date.now() - 2 * DAY) } },
    orderBy: { createdAt: 'desc' },
    take: 3,
  });
  await Promise.all(pending.map((p) => verifySubscriptionPayment(p).catch(() => 'unavailable')));
}

/**
 * Daily housekeeping (runs inside the existing daily cron — the Hobby plan
 * allows only two cron jobs): confirm or close pending payments, remind
 * sellers 3 days before access ends, and tell them once when it lapsed.
 */
export async function runSubscriptionHousekeeping(now: Date = new Date()): Promise<{ verified: number; closed: number; reminded: number; lapsed: number }> {
  let verified = 0;
  let closed = 0;
  let reminded = 0;
  let lapsed = 0;
  // Yoco is asked five payments at a time, within ~40 s in all, so the daily
  // job always finishes inside its time limit (anything left waits for
  // tomorrow or the seller's next dashboard visit).
  const started = Date.now();
  const canAsk = Boolean(platformYocoKey());
  if (canAsk) {
    const pending = await db.subscriptionPayment.findMany({
      where: { status: 'pending', yocoCheckoutId: { not: null }, createdAt: { gt: new Date(now.getTime() - 3 * DAY) } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    for (let i = 0; i < pending.length && Date.now() - started < 25_000; i += 5) {
      const results = await Promise.all(pending.slice(i, i + 5).map((p) => verifySubscriptionPayment(p).catch(() => 'unavailable')));
      verified += results.filter((r) => r === 'paid').length;
    }
  }
  // Checkouts nobody completed within 3 days are closed (Yoco sessions
  // expire) — after one last look at Yoco, so a payment that went through
  // while Yoco could not be reached is credited, never cancelled.
  const stale = await db.subscriptionPayment.findMany({
    where: { status: 'pending', createdAt: { lte: new Date(now.getTime() - 3 * DAY) } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  for (let i = 0; i < stale.length && Date.now() - started < 40_000; i += 5) {
    await Promise.all(stale.slice(i, i + 5).map(async (p) => {
      if (p.yocoCheckoutId) {
        if (!canAsk) return; // cannot ask Yoco: keep it until we can
        const r = await verifySubscriptionPayment(p).catch(() => 'unavailable' as const);
        if (r === 'paid') { verified++; return; }
        if (r !== 'pending') return; // 'failed' is already recorded; 'unavailable' → try again tomorrow
      }
      closed += (await db.subscriptionPayment.updateMany({ where: { id: p.id, status: 'pending' }, data: { status: 'cancelled' } })).count;
    }));
  }

  const soon = await db.store.findMany({
    where: { status: 'active', billingExempt: false, accessUntil: { gt: now, lte: new Date(now.getTime() + 3 * DAY) } },
    select: { id: true, name: true, userId: true, accessUntil: true, billingNotice: true, paidUntil: true },
    take: 1000,
  });
  for (const s of soon) {
    const key = `soon:${s.accessUntil!.toISOString()}`;
    if (s.billingNotice === key) continue;
    await db.store.update({ where: { id: s.id }, data: { billingNotice: key } });
    const days = Math.max(1, Math.ceil((s.accessUntil!.getTime() - now.getTime()) / DAY));
    const what = s.paidUntil && s.paidUntil.getTime() >= s.accessUntil!.getTime() ? 'subscription' : 'free trial';
    void notify({ userId: s.userId, type: 'subscription', title: `Your ${what} ends in ${days} day${days === 1 ? '' : 's'}`, body: `Renew your Green Gate subscription for “${s.name}” (${randLabel(planPriceCents('monthly'))} a month or ${randLabel(planPriceCents('yearly'))} a year) so your store and products stay live.`, link: '/dashboard' });
    reminded++;
  }
  const ended = await db.store.findMany({
    where: { status: 'active', billingExempt: false, accessUntil: { lte: now, gt: new Date(now.getTime() - 7 * DAY) } },
    select: { id: true, name: true, userId: true, accessUntil: true, billingNotice: true },
    take: 1000,
  });
  for (const s of ended) {
    const key = `expired:${s.accessUntil!.toISOString()}`;
    if (s.billingNotice === key) continue;
    await db.store.update({ where: { id: s.id }, data: { billingNotice: key } });
    void notify({ userId: s.userId, type: 'subscription', title: 'Your store is paused', body: `Your Green Gate subscription for “${s.name}” has ended, so your store and products are hidden from buyers. Pay in your seller dashboard to bring them back instantly.`, link: '/dashboard' });
    lapsed++;
  }
  return { verified, closed, reminded, lapsed };
}
