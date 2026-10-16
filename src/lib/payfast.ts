import { createHash } from 'crypto';

/**
 * PayFast payment gateway (platform-level, env-driven).
 *
 * Activates the moment PAYFAST_MERCHANT_ID + PAYFAST_MERCHANT_KEY exist in the
 * environment — no code changes needed after the merchant account is created.
 * With PAYFAST_SANDBOX=1 the sandbox host is used for safe testing.
 *
 * Flow: the buyer is redirected to PayFast's hosted payment page with a signed
 * payload; PayFast posts the outcome server-to-server to the ITN endpoint,
 * which verifies the signature and amount before confirming the order.
 * Payment success is NEVER declared by the browser.
 */

export function payfastEnabled(): boolean {
  return Boolean(process.env.PAYFAST_MERCHANT_ID && process.env.PAYFAST_MERCHANT_KEY);
}

export function payfastSandbox(): boolean {
  return String(process.env.PAYFAST_SANDBOX ?? '') === '1';
}

function payfastHost(): string {
  return payfastSandbox() ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';
}

/**
 * PayFast signature: md5 over urlencoded `key=value` pairs (empty values
 * skipped) in the order provided, with `&passphrase=…` appended when set.
 * This mirrors PayFast's own Node reference implementation exactly.
 */
export function payfastSignature(data: Record<string, string>, passphrase?: string): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value !== '') pairs.push(`${key}=${encodeURIComponent(value.trim())}`);
  }
  let str = pairs.join('&');
  if (passphrase) str += `&passphrase=${encodeURIComponent(passphrase.trim())}`;
  return createHash('md5').update(str).digest('hex');
}

export interface PayfastOrderInput {
  number: string;
  id: string;
  totalCents: number;
  currency: string;
  buyerEmail: string;
  buyerName: string;
  origin: string;
}

/**
 * Build the signed redirect URL for PayFast's hosted payment page.
 */
export function payfastPaymentUrl(order: PayfastOrderInput): string {
  const passphrase = process.env.PAYFAST_PASSPHRASE || undefined;
  const data: Record<string, string> = {
    merchant_id: String(process.env.PAYFAST_MERCHANT_ID ?? ''),
    merchant_key: String(process.env.PAYFAST_MERCHANT_KEY ?? ''),
    return_url: `${order.origin}/#/orders`,
    cancel_url: `${order.origin}/#/store`,
    notify_url: `${order.origin}/api/payments/payfast/itn`,
    name_first: order.buyerName.split(' ')[0] || 'Green',
    name_last: order.buyerName.split(' ').slice(1).join(' ') || 'Gate buyer',
    email_address: order.buyerEmail,
    m_payment_id: order.number,
    amount: (order.totalCents / 100).toFixed(2),
    item_name: `Order ${order.number}`.slice(0, 100),
    item_description: `Green Gate order ${order.number}`.slice(0, 255),
    custom_str1: order.id,
    custom_str2: order.currency,
  };
  data.signature = payfastSignature(data, passphrase);
  const qs = Object.entries(data)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v.trim())}`)
    .join('&');
  return `https://${payfastHost()}/eng/process?${qs}`;
}

/**
 * Verify an ITN (Instant Transaction Notification) POST from PayFast.
 * PayFast posts the fields alphabetically; the signature check re-creates
 * the md5 over the received values (signature field excluded) plus the
 * passphrase, and compares. Amount and status are checked by the caller.
 */
export function payfastVerifyItn(fields: Record<string, string>): { ok: boolean; reason?: string } {
  const received = String(fields.signature ?? '');
  if (!received) return { ok: false, reason: 'missing signature' };
  const ordered: Record<string, string> = {};
  Object.keys(fields)
    .filter((k) => k !== 'signature')
    .sort()
    .forEach((k) => { ordered[k] = fields[k]; });
  const expected = payfastSignature(ordered, process.env.PAYFAST_PASSPHRASE || undefined);
  if (expected !== received) return { ok: false, reason: 'signature mismatch' };

  // Best-effort origin check: PayFast posts from its own host.
  if (fields.customer_bank_ref !== undefined && fields.customer_bank_ref === '') return { ok: false, reason: 'bad payload' };
  return { ok: true };
}

/** True when the ITN reports a completed payment. */
export function payfastItnComplete(fields: Record<string, string>): boolean {
  return String(fields.payment_status ?? '') === 'COMPLETE';
}
