import { createHash, timingSafeEqual } from 'crypto';

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
  // A passphrase is REQUIRED for the marketplace rail: without one the ITN
  // signature is md5 over public, attacker-computable fields — anyone could
  // forge a "COMPLETE" notification for any order number.
  return Boolean(process.env.PAYFAST_MERCHANT_ID && process.env.PAYFAST_MERCHANT_KEY && process.env.PAYFAST_PASSPHRASE);
}

export function payfastSandbox(): boolean {
  return String(process.env.PAYFAST_SANDBOX ?? '') === '1';
}

/** PayFast's hosts — www for live money, sandbox for test accounts. */
export function payfastBaseUrl(sandbox: boolean): string {
  return sandbox ? 'https://sandbox.payfast.co.za' : 'https://www.payfast.co.za';
}

/**
 * PHP `urlencode()` — what PayFast signs with: spaces as '+', uppercase hex,
 * and ! ' ( ) * ~ escaped too. Plain encodeURIComponent writes spaces as %20,
 * so every signature over a value with a space ("Order GG-…") mismatched and
 * PayFast rejected the payment.
 */
export function payfastEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

/** Keeps free text (names, store names) to characters every PayFast encoder
 *  agrees on, so form signatures can never diverge on punctuation. */
export function payfastText(value: string, max: number): string {
  return value.replace(/[!'()*~"<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * PayFast form signature: md5 over `key=value` pairs in the order the fields
 * are posted (PayFast's attribute order — NOT alphabetical), empty values
 * skipped, values PHP-urlencoded, with `&passphrase=…` appended when set.
 */
export function payfastSignature(data: Record<string, string>, passphrase?: string): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value.trim() !== '') pairs.push(`${key}=${payfastEncode(value.trim())}`);
  }
  let str = pairs.join('&');
  if (passphrase) str += `&passphrase=${payfastEncode(passphrase.trim())}`;
  return createHash('md5').update(str).digest('hex');
}

/**
 * The ITN parameter string: every received field IN THE ORDER RECEIVED up to
 * the signature (empty values included), PHP-urlencoded. The same string is
 * signed by PayFast and posted back to /eng/query/validate.
 */
export function payfastItnParamString(fields: Record<string, string>, encode: (v: string) => string = payfastEncode): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'signature') continue;
    pairs.push(`${key}=${encode(value.trim())}`);
  }
  return pairs.join('&');
}

/** Signature check for an ITN with the given passphrase. Accepts PayFast's
 *  PHP encoding and its Node sample's encoding (both need the passphrase). */
export function payfastItnSignatureValid(fields: Record<string, string>, passphrase: string): boolean {
  const received = String(fields.signature ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(received)) return false;
  const nodeEncode = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
  return [payfastEncode, nodeEncode].some((encode) => {
    const base = payfastItnParamString(fields, encode);
    const expected = createHash('md5').update(`${base}&passphrase=${encode(passphrase.trim())}`).digest('hex');
    return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  });
}

/**
 * Server confirmation (PayFast's 4th ITN check): post the received data back
 * to PayFast, which answers "VALID" only for a notification it really sent.
 * Returns null when PayFast could not be reached (caller retries later).
 */
export async function payfastServerConfirms(fields: Record<string, string>, sandbox: boolean): Promise<boolean | null> {
  try {
    const res = await fetch(`${payfastBaseUrl(sandbox)}/eng/query/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payfastItnParamString(fields),
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.text()).trim() === 'VALID';
  } catch {
    return null;
  }
}

/** Auto-submitting POST form to PayFast's payment page (top-level — PayFast
 *  must not be framed), with a manual button when scripts are blocked. */
export function payfastRedirectPage(processUrl: string, fields: { name: string; value: string }[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inputs = fields.map((f) => `<input type="hidden" name="${esc(f.name)}" value="${esc(f.value)}">`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Redirecting to PayFast…</title></head>`
    + `<body style="font-family:Arial,sans-serif;text-align:center;padding:40px 16px;color:#111827">`
    + `<form id="pf" method="post" action="${esc(processUrl)}">${inputs}<p>Taking you to PayFast's secure payment page…</p><button type="submit" style="padding:10px 18px;background:#16a34a;color:#fff;border:0;border-radius:6px;font-weight:700">Continue to PayFast</button></form>`
    + `<script>document.getElementById('pf').submit();</script></body></html>`;
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
 * Build the signed form for PayFast's hosted payment page (marketplace
 * account). Posted top-level via payfastRedirectPage — PayFast's documented
 * Custom Integration; success is decided only by the verified ITN.
 */
export function payfastPaymentForm(order: PayfastOrderInput): { processUrl: string; fields: { name: string; value: string }[] } {
  const passphrase = process.env.PAYFAST_PASSPHRASE || undefined;
  const name = payfastText(order.buyerName, 100).split(' ');
  const data: Record<string, string> = {
    merchant_id: String(process.env.PAYFAST_MERCHANT_ID ?? '').trim(),
    merchant_key: String(process.env.PAYFAST_MERCHANT_KEY ?? '').trim(),
    return_url: `${order.origin}/#/orders`,
    cancel_url: `${order.origin}/#/orders`,
    notify_url: `${order.origin}/api/payments/payfast/itn`,
    name_first: name[0] || 'Green',
    name_last: name.slice(1).join(' ') || 'Gate buyer',
    email_address: order.buyerEmail.trim(),
    m_payment_id: order.number,
    amount: (order.totalCents / 100).toFixed(2),
    item_name: `Order ${order.number}`,
    item_description: `Green Gate order ${order.number}`,
    custom_str1: order.id,
    custom_str2: order.currency,
  };
  const signature = payfastSignature(data, passphrase);
  const fields = Object.entries(data)
    .filter(([, v]) => v.trim() !== '')
    .map(([n, v]) => ({ name: n, value: v.trim() }));
  fields.push({ name: 'signature', value: signature });
  return { processUrl: `${payfastBaseUrl(payfastSandbox())}/eng/process`, fields };
}

/**
 * Verify an ITN (Instant Transaction Notification) for the MARKETPLACE
 * account: signature over the fields in the order PayFast posted them (not
 * sorted) with the marketplace passphrase, plus the merchant id. The caller
 * adds the amount check and PayFast's server confirmation.
 */
export function payfastVerifyItn(fields: Record<string, string>): { ok: boolean; reason?: string } {
  if (!fields.signature) return { ok: false, reason: 'missing signature' };
  // Fail closed: an unsigned (no-passphrase) signature is forgeable md5 over
  // public fields, so verification is refused outright without one.
  const passphrase = process.env.PAYFAST_PASSPHRASE;
  if (!passphrase) return { ok: false, reason: 'passphrase not configured' };
  if (!payfastItnSignatureValid(fields, passphrase)) return { ok: false, reason: 'signature mismatch' };
  if (fields.merchant_id?.trim() !== String(process.env.PAYFAST_MERCHANT_ID ?? '').trim()) return { ok: false, reason: 'merchant id mismatch' };
  return { ok: true };
}

/** True when the ITN reports a completed payment. */
export function payfastItnComplete(fields: Record<string, string>): boolean {
  return String(fields.payment_status ?? '') === 'COMPLETE';
}
