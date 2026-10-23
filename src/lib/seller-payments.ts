import { createHash } from 'crypto';
import { db } from '@/lib/db';
import { decryptSecret } from '@/lib/secret-box';
import { payfastSignature } from '@/lib/payfast';

/**
 * Seller-owned payment processors — IN-APP Ozow + PayFast.
 *
 * Sellers connect their own Ozow and/or PayFast accounts in Seller dashboard
 * → Payment details. Buyers then pay INSIDE the app:
 *  - PayFast Onsite ("lightbox"): the buyer completes card / SiD instant EFT
 *    in a popup frame rendered ON our page — no redirect away, no link.
 *    Server-side truth: PayFast posts the ITN webhook, we verify it with the
 *    SELLER's passphrase and confirm through the shared settlement
 *    choke-point (settleOrderPayment) — the browser is never trusted.
 *  - Ozow instant EFT: the transaction is created server-to-server and the
 *    Ozow bank-selection flow is rendered in an in-app frame. Server-side
 *    truth: the Ozow notify webhook (hash-verified) cross-checked with an
 *    authenticated status query whenever the seller added an API key.
 *
 * Security invariants (identical to every other payment path):
 *  - Secrets are AES-256-GCM encrypted at rest (secret-box) and are never
 *    returned by any API — only "connected" booleans.
 *  - A payment is confirmed ONLY on verified server-to-server proof.
 *  - Amounts are always the full order total, which already includes the
 *    The-Courier-Guy delivery fee — delivery is paid in-app in the same
 *    charge as the goods.
 *  - Every external call is defensive: a processor outage degrades to the
 *    next rail (Yoco → GGPay card → link → bank transfer), checkout NEVER
 *    blocks.
 */

export interface SellerProcessorStore {
  id: string;
  name: string;
  // Optional so callers can select only the fields their rail needs.
  payfastMerchantId?: string | null;
  payfastMerchantKeyEnc?: string | null;
  payfastPassphraseEnc?: string | null;
  ozowSiteCode?: string | null;
  ozowPrivateKeyEnc?: string | null;
  ozowApiKeyEnc?: string | null;
}

export interface SellerPayOrder {
  id: string;
  number: string;
  totalCents: number;
  buyerEmail: string;
  buyerName: string;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export function payfastSellerReady(store: SellerProcessorStore): boolean {
  // A passphrase is REQUIRED: without one the ITN signature is md5 over
  // public, attacker-computable fields only — no payment on this rail could
  // ever be verified, so the rail is simply not offered until it is set.
  return Boolean(
    store.payfastMerchantId &&
    store.payfastMerchantId.trim() &&
    decryptSecret(store.payfastMerchantKeyEnc) &&
    decryptSecret(store.payfastPassphraseEnc),
  );
}

export function ozowSellerReady(store: SellerProcessorStore): boolean {
  return Boolean(
    store.ozowSiteCode &&
    store.ozowSiteCode.trim() &&
    decryptSecret(store.ozowPrivateKeyEnc),
  );
}

// ---------------------------------------------------------------------------
// PayFast Onsite (in-app lightbox — card + SiD instant EFT)
// ---------------------------------------------------------------------------

export function payfastSandboxHost(): boolean {
  return String(process.env.PAYFAST_SANDBOX ?? '') === '1';
}

export interface OnsiteSubmission {
  submission: { name: string; value: string }[];
  processUrl: string;
  sandbox: boolean;
}

/**
 * Build the signed PayFast Onsite submission for an order using the SELLER's
 * merchant credentials. The signature covers the passphrase server-side; the
 * submission itself only contains public form fields.
 */
export function payfastOnsiteSubmission(order: SellerPayOrder, store: SellerProcessorStore, origin: string): OnsiteSubmission | null {
  if (!payfastSellerReady(store)) return null;
  const merchantKey = decryptSecret(store.payfastMerchantKeyEnc);
  if (!merchantKey) return null;
  const passphrase = decryptSecret(store.payfastPassphraseEnc);
  if (!passphrase) return null;

  const data: Record<string, string> = {
    merchant_id: store.payfastMerchantId!.trim(),
    merchant_key: merchantKey.trim(),
    return_url: `${origin}/#/orders`,
    cancel_url: `${origin}/#/orders`,
    notify_url: `${origin}/api/payments/payfast/itn`,
    name_first: order.buyerName.split(' ')[0] || 'Green',
    name_last: order.buyerName.split(' ').slice(1).join(' ') || 'Gate buyer',
    email_address: order.buyerEmail,
    m_payment_id: order.number,
    amount: (order.totalCents / 100).toFixed(2),
    item_name: `Order ${order.number}`.slice(0, 100),
    item_description: `Green Gate order ${order.number} — ${store.name}`.slice(0, 255),
    custom_str1: order.id,
    // Marks this ITN as a SELLER-owned payment so the webhook verifies with
    // the seller's passphrase (marketplace payments keep using the env one).
    custom_str2: `seller:${store.id}`,
  };
  data.signature = payfastSignature(data, passphrase);

  const sandbox = payfastSandboxHost();
  return {
    submission: Object.entries(data).map(([name, value]) => ({ name, value })),
    processUrl: sandbox ? 'https://sandbox.payfast.io/eng/process' : 'https://payfast.io/eng/process',
    sandbox,
  };
}

/**
 * Verify a PayFast ITN with the SELLER's passphrase (used when
 * custom_str2 = "seller:<storeId>").
 */
export function payfastVerifySellerItn(fields: Record<string, string>, store: SellerProcessorStore): { ok: boolean; reason?: string } {
  const received = String(fields.signature ?? '');
  if (!received) return { ok: false, reason: 'missing signature' };
  const merchantKey = decryptSecret(store.payfastMerchantKeyEnc);
  if (!merchantKey) return { ok: false, reason: 'seller merchant key unreadable' };
  const passphrase = decryptSecret(store.payfastPassphraseEnc);
  if (!passphrase) return { ok: false, reason: 'seller passphrase not configured' };
  const ordered: Record<string, string> = {};
  Object.keys(fields)
    .filter((k) => k !== 'signature')
    .sort()
    .forEach((k) => { ordered[k] = fields[k]; });
  const expected = payfastSignature(ordered, passphrase);
  if (expected !== received) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Ozow instant EFT (in-app frame)
// ---------------------------------------------------------------------------

const OZOW_API = 'https://api.ozow.com';

function ozowPrivateKey(store: SellerProcessorStore): string | null {
  return decryptSecret(store.ozowPrivateKeyEnc);
}

function ozowIsTest(): boolean {
  // An explicit OZOW_IS_TEST always wins. Otherwise production runs LIVE by
  // default — test transactions return Status 'Complete' while no money
  // moves, so defaulting production to test would let unpaid orders confirm.
  // Development and preview default to test so integration never risks real
  // charges.
  const raw = String(process.env.OZOW_IS_TEST ?? '').trim();
  if (raw === '0') return false;
  if (raw === '1') return true;
  return process.env.NODE_ENV !== 'production';
}

/** SHA-512 hex — Ozow's hash algorithm for every request/notification.
 *  Ozow's documented recipe lowercases the concatenated string (private key
 *  included) BEFORE hashing; without that every hash Ozow checks mismatches. */
function ozowHash(input: string): string {
  return createHash('sha512').update(input.toLowerCase()).digest('hex');
}

/** Compare a received Ozow hash with ours: case-insensitive and ignoring
 *  leading zeros (Ozow notes some SHA-512 implementations drop them). */
function ozowHashMatches(received: string, expected: string): boolean {
  const norm = (h: string) => h.trim().toLowerCase().replace(/^0+/, '');
  return norm(received) !== '' && norm(received) === norm(expected);
}

export interface OzowTransaction {
  transactionId: string;
  paymentUrl: string;
  isTest: boolean;
}

/**
 * Create an Ozow transaction server-to-server for an order. Returns null on
 * ANY failure (network, parse, reject) — callers then fall back to the next
 * rail. Hash input follows Ozow's PostTransactionRequest order exactly:
 * SiteCode + CountryCode + CurrencyCode + Amount + TransactionReference +
 * BankReference + CancelUrl + ErrorUrl + SuccessUrl + NotifyUrl + IsTest +
 * privateKey. Amount is hashed with exactly 2 decimals.
 */
export async function ozowCreateTransaction(order: SellerPayOrder, store: SellerProcessorStore, origin: string): Promise<OzowTransaction | null> {
  const privateKey = ozowPrivateKey(store);
  if (!privateKey || !store.ozowSiteCode) return null;

  const amountStr = (order.totalCents / 100).toFixed(2);
  const isTest = ozowIsTest();
  const body = {
    SiteCode: store.ozowSiteCode.trim(),
    CountryCode: 'ZA',
    CurrencyCode: 'ZAR',
    Amount: amountStr,
    TransactionReference: order.number,
    BankReference: order.number.replace(/^GG-/, 'GG'),
    CancelUrl: `${origin}/#/orders`,
    ErrorUrl: `${origin}/#/orders`,
    SuccessUrl: `${origin}/#/orders`,
    NotifyUrl: `${origin}/api/payments/ozow/notify`,
    IsTest: isTest,
  };
  const hash = ozowHash(
    body.SiteCode + body.CountryCode + body.CurrencyCode + body.Amount + body.TransactionReference +
    body.BankReference + body.CancelUrl + body.ErrorUrl + body.SuccessUrl + body.NotifyUrl +
    String(body.IsTest) + privateKey,
  );

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(`${OZOW_API}/PostTransactionRequest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', HashCheck: hash },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const raw: unknown = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      return null;
    };
    // Ozow responses have mixed casing across API versions — accept both.
    const transactionId = pick('TransactionId', 'transactionId', 'TransactionID');
    const paymentUrl = pick('Url', 'url', 'PaymentUrl', 'paymentUrl');
    if (!transactionId || !paymentUrl) return null;
    return { transactionId, paymentUrl, isTest };
  } catch {
    return null;
  }
}

/**
 * Authenticated status query for an Ozow transaction. Confirmed positive
 * status is the strongest proof (stronger than the notify hash alone) —
 * used before any order confirmation whenever the seller added an API key.
 * GetTransaction hash input: SiteCode + TransactionId + privateKey.
 */
export async function ozowStatusPaid(orderNumber: string, store: SellerProcessorStore, transactionId?: string, expectedAmountCents?: number): Promise<{ paid: boolean; status: string | null; amount: string | null; reference: string | null } | null> {
  const privateKey = ozowPrivateKey(store);
  if (!privateKey || !store.ozowSiteCode) return null;
  const apiKey = decryptSecret(store.ozowApiKeyEnc);
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const url = new URL(`${OZOW_API}/transaction/gettransaction`);
    url.searchParams.set('siteCode', store.ozowSiteCode.trim());
    url.searchParams.set('transactionId', (transactionId ?? orderNumber).trim());
    const hash = ozowHash(store.ozowSiteCode.trim() + (transactionId ?? orderNumber).trim() + privateKey);
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json', apikey: apiKey, HashCheck: hash },
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const raw: unknown = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const status = typeof obj.Status === 'string' ? obj.Status : typeof obj.status === 'string' ? obj.status : null;
    const amount = typeof obj.Amount === 'string' ? obj.Amount : typeof obj.amount === 'string' ? obj.amount : null;
    const reference = typeof obj.TransactionReference === 'string' ? obj.TransactionReference : typeof obj.TransactionReferenceId === 'string' ? obj.TransactionReferenceId : null;

    // Fail-closed verification: a transaction only counts as paid for THIS
    // order when Ozow reports Complete AND the paid amount equals the order
    // total (2 decimals) AND — when Ozow reports the reference — it is this
    // order's number. Without the amount check, a small real payment on one
    // order could be replayed as proof for a much larger one.
    let paid = status === 'Complete';
    if (paid && expectedAmountCents !== undefined) {
      if (!amount || amount !== (expectedAmountCents / 100).toFixed(2)) paid = false;
      if (paid && reference && reference !== orderNumber) paid = false;
    }
    return { paid, status, amount, reference };
  } catch {
    return null;
  }
}

/**
 * Verify an Ozow notify webhook payload with the documented notification
 * hash. Ozow's notification hash input: TransactionId + Status + SiteCode +
 * TransactionReference + TransactionDate + Amount + RequestedAmount +
 * privateKey. Fields are accepted case-insensitively. A mismatch NEVER
 * confirms an order — the caller fails closed.
 */
export function ozowVerifyNotification(payload: Record<string, string>, store: SellerProcessorStore): { ok: boolean; reason?: string } {
  const received = payload.hash ?? payload.Hash ?? payload.HashCheck ?? '';
  if (!received) return { ok: false, reason: 'missing hash' };
  const privateKey = ozowPrivateKey(store);
  if (!privateKey) return { ok: false, reason: 'seller private key unreadable' };

  const get = (...keys: string[]) => {
    for (const k of keys) {
      const v = payload[k];
      if (v !== undefined && v !== '') return v;
    }
    return '';
  };
  const input =
    get('TransactionId', 'TransactionID') +
    get('Status') +
    get('SiteCode') +
    get('TransactionReference') +
    get('TransactionDate') +
    get('Amount') +
    get('RequestedAmount') +
    privateKey;
  if (!ozowHashMatches(received, ozowHash(input))) return { ok: false, reason: 'hash mismatch' };
  return { ok: true };
}
