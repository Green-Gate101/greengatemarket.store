import { createHash, timingSafeEqual } from 'crypto';
import { db } from '@/lib/db';
import { decryptSecret } from '@/lib/secret-box';
import { payfastBaseUrl, payfastItnSignatureValid, payfastSignature, payfastText } from '@/lib/payfast';

/**
 * Seller-owned payment processors — Ozow + PayFast.
 *
 * Sellers connect their own Ozow and/or PayFast accounts in Seller dashboard
 * → Payment details. Buyers pay on the processor's own secure page (both
 * processors require a full-page redirect — neither may be framed) and come
 * straight back to their orders:
 *  - PayFast: a signed POST to PayFast's payment page (card / instant EFT).
 *    Server-side truth: PayFast posts the ITN webhook, we verify it with the
 *    SELLER's passphrase, PayFast confirms it ("VALID"), and the order settles
 *    through the shared choke-point (settleOrderPayment) — the browser is
 *    never trusted.
 *  - Ozow instant EFT (Payments API): the payment request is created
 *    server-to-server; the notify webhook (hash-verified with the seller's
 *    private key) and an authenticated status query decide success.
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
  // Ozow's payment-request API authenticates with the API key (ApiKey header)
  // and signs with the private key — without BOTH no payment can be created.
  return Boolean(
    store.ozowSiteCode &&
    store.ozowSiteCode.trim() &&
    decryptSecret(store.ozowPrivateKeyEnc) &&
    decryptSecret(store.ozowApiKeyEnc),
  );
}

// ---------------------------------------------------------------------------
// PayFast (seller's own merchant account — card + instant EFT)
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
 * Build the signed PayFast payment form for an order using the SELLER's
 * merchant credentials. The browser posts it top-level to PayFast's payment
 * page (www.payfast.co.za — payfast.io/eng/process answers 404). The
 * signature covers the passphrase server-side; the form itself only carries
 * public fields.
 */
export function payfastOnsiteSubmission(order: SellerPayOrder, store: SellerProcessorStore, origin: string): OnsiteSubmission | null {
  if (!payfastSellerReady(store)) return null;
  const merchantKey = decryptSecret(store.payfastMerchantKeyEnc);
  if (!merchantKey) return null;
  const passphrase = decryptSecret(store.payfastPassphraseEnc);
  if (!passphrase) return null;

  const name = payfastText(order.buyerName, 100).split(' ');
  const data: Record<string, string> = {
    merchant_id: store.payfastMerchantId!.trim(),
    merchant_key: merchantKey.trim(),
    return_url: `${origin}/#/orders`,
    cancel_url: `${origin}/#/orders`,
    notify_url: `${origin}/api/payments/payfast/itn`,
    name_first: name[0] || 'Green',
    name_last: name.slice(1).join(' ') || 'Gate buyer',
    email_address: order.buyerEmail.trim(),
    m_payment_id: order.number,
    amount: (order.totalCents / 100).toFixed(2),
    item_name: `Order ${order.number}`,
    item_description: payfastText(`Green Gate order ${order.number} - ${store.name}`, 255),
    custom_str1: order.id,
    // Marks this ITN as a SELLER-owned payment so the webhook verifies with
    // the seller's passphrase (marketplace payments keep using the env one).
    custom_str2: `seller:${store.id}`,
  };
  const signature = payfastSignature(data, passphrase);
  const submission = Object.entries(data)
    .filter(([, v]) => v.trim() !== '')
    .map(([n, v]) => ({ name: n, value: v.trim() }));
  submission.push({ name: 'signature', value: signature });

  const sandbox = payfastSandboxHost();
  return { submission, processUrl: `${payfastBaseUrl(sandbox)}/eng/process`, sandbox };
}

/**
 * Verify a PayFast ITN with the SELLER's passphrase (used when
 * custom_str2 = "seller:<storeId>") — fields in the order PayFast posted them.
 */
export function payfastVerifySellerItn(fields: Record<string, string>, store: SellerProcessorStore): { ok: boolean; reason?: string } {
  if (!fields.signature) return { ok: false, reason: 'missing signature' };
  const merchantKey = decryptSecret(store.payfastMerchantKeyEnc);
  if (!merchantKey) return { ok: false, reason: 'seller merchant key unreadable' };
  const passphrase = decryptSecret(store.payfastPassphraseEnc);
  if (!passphrase) return { ok: false, reason: 'seller passphrase not configured' };
  if (!payfastItnSignatureValid(fields, passphrase)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Ozow instant EFT — Payments API (hub.ozow.com/api-reference/payments-api)
// ---------------------------------------------------------------------------

const OZOW_API = 'https://api.ozow.com';

function ozowPrivateKey(store: SellerProcessorStore): string | null {
  return decryptSecret(store.ozowPrivateKeyEnc);
}

export function ozowIsTest(): boolean {
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
  const a = Buffer.from(norm(received));
  const b = Buffer.from(norm(expected));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export interface OzowTransaction {
  paymentRequestId: string;
  paymentUrl: string;
  isTest: boolean;
}

/**
 * Create an Ozow payment request server-to-server (POST /postpaymentrequest,
 * `ApiKey` header, `hashCheck` in the JSON body). Hash: the sent fields in
 * Ozow's documented order — siteCode, countryCode, currencyCode, amount,
 * transactionReference, bankReference, cancelUrl, errorUrl, successUrl,
 * notifyUrl, isTest — then the private key, lowercased, SHA-512. Ozow
 * answers 200 even on rejection: only a populated `url` with no
 * `errorMessage` is a created request. Returns null on ANY failure.
 */
export async function ozowCreateTransaction(order: SellerPayOrder, store: SellerProcessorStore, origin: string): Promise<OzowTransaction | null> {
  const privateKey = ozowPrivateKey(store);
  const apiKey = decryptSecret(store.ozowApiKeyEnc);
  if (!privateKey || !apiKey || !store.ozowSiteCode) return null;

  const isTest = ozowIsTest();
  const body = {
    siteCode: store.ozowSiteCode.trim(),
    countryCode: 'ZA',
    currencyCode: 'ZAR',
    amount: (order.totalCents / 100).toFixed(2),
    transactionReference: order.number,
    // Shown on the buyer's bank statement: alphanumeric, max 20.
    bankReference: order.number.replace(/[^A-Za-z0-9]/g, '').slice(0, 20),
    cancelUrl: `${origin}/#/orders`,
    errorUrl: `${origin}/#/orders`,
    successUrl: `${origin}/#/orders`,
    notifyUrl: `${origin}/api/payments/ozow/notify`,
    isTest,
  };
  const hashCheck = ozowHash(
    body.siteCode + body.countryCode + body.currencyCode + body.amount + body.transactionReference +
    body.bankReference + body.cancelUrl + body.errorUrl + body.successUrl + body.notifyUrl +
    String(body.isTest) + privateKey,
  );

  try {
    const res = await fetch(`${OZOW_API}/postpaymentrequest`, {
      method: 'POST',
      headers: { ApiKey: apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...body, hashCheck }),
      signal: AbortSignal.timeout(12_000),
      cache: 'no-store',
    });
    if (!res.ok) {
      console.error('ozow payment request failed:', res.status);
      return null;
    }
    const data = (await res.json().catch(() => null)) as { paymentRequestId?: string; url?: string; errorMessage?: string | null } | null;
    if (!data?.url || data.errorMessage) {
      console.error('ozow payment request rejected:', data?.errorMessage ?? 'no url');
      return null;
    }
    return { paymentRequestId: String(data.paymentRequestId ?? ''), paymentUrl: data.url, isTest };
  } catch (e) {
    console.error('ozow payment request error:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Authenticated status query: GET /GetTransactionByReference (ApiKey header)
 * for this order's reference. Paid only when a returned transaction is
 * Complete for EXACTLY the order total and this order's reference (fail
 * closed — a small real payment can never vouch for a larger order).
 */
export async function ozowStatusPaid(orderNumber: string, store: SellerProcessorStore, transactionId?: string, expectedAmountCents?: number): Promise<{ paid: boolean; status: string | null; amount: string | null; reference: string | null; transactionId: string | null } | null> {
  const apiKey = decryptSecret(store.ozowApiKeyEnc);
  if (!apiKey || !store.ozowSiteCode) return null;

  try {
    const url = new URL(`${OZOW_API}/GetTransactionByReference`);
    url.searchParams.set('siteCode', store.ozowSiteCode.trim());
    url.searchParams.set('transactionReference', orderNumber.trim());
    if (ozowIsTest()) url.searchParams.set('isTest', 'true');
    const res = await fetch(url.toString(), {
      headers: { ApiKey: apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const raw: unknown = await res.json().catch(() => null);
    const rows = (Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []) as Record<string, unknown>[];
    const field = (o: Record<string, unknown>, ...keys: string[]) => {
      for (const k of keys) if (o[k] !== undefined && o[k] !== null) return String(o[k]);
      return null;
    };
    const expected = expectedAmountCents !== undefined ? (expectedAmountCents / 100).toFixed(2) : null;
    let last: { paid: boolean; status: string | null; amount: string | null; reference: string | null; transactionId: string | null } | null = null;
    for (const o of rows) {
      const status = field(o, 'status', 'Status');
      const amountRaw = field(o, 'amount', 'Amount');
      const amount = amountRaw !== null && Number.isFinite(Number(amountRaw)) ? Number(amountRaw).toFixed(2) : null;
      const reference = field(o, 'transactionReference', 'TransactionReference');
      const txId = field(o, 'transactionId', 'TransactionId');
      if (transactionId && txId && txId !== transactionId) continue;
      const paid = status === 'Complete' && reference === orderNumber && (expected === null || amount === expected);
      last = { paid, status, amount, reference, transactionId: txId };
      if (paid) return last;
    }
    return last ?? { paid: false, status: null, amount: null, reference: null, transactionId: null };
  } catch {
    return null;
  }
}

/**
 * Verify an Ozow notify webhook with the documented notification hash:
 * SiteCode, TransactionId, TransactionReference, Amount, Status,
 * Optional1–Optional5, CurrencyCode, IsTest, StatusMessage, then the
 * private key — lowercased, SHA-512, compared with `Hash`. A mismatch NEVER
 * confirms an order — the caller fails closed.
 */
export function ozowVerifyNotification(payload: Record<string, string>, store: SellerProcessorStore): { ok: boolean; reason?: string } {
  const received = payload.Hash ?? payload.hash ?? '';
  if (!received) return { ok: false, reason: 'missing hash' };
  const privateKey = ozowPrivateKey(store);
  if (!privateKey) return { ok: false, reason: 'seller private key unreadable' };

  const get = (key: string) => payload[key] ?? payload[key.charAt(0).toLowerCase() + key.slice(1)] ?? '';
  const input = ['SiteCode', 'TransactionId', 'TransactionReference', 'Amount', 'Status',
    'Optional1', 'Optional2', 'Optional3', 'Optional4', 'Optional5', 'CurrencyCode', 'IsTest', 'StatusMessage']
    .map(get).join('') + privateKey;
  if (!ozowHashMatches(received, ozowHash(input))) return { ok: false, reason: 'hash mismatch' };
  return { ok: true };
}
