/**
 * Transactional email via Resend. All emails are generated server-side.
 * Best-effort with retry: a failure logs a warning and never blocks a
 * customer's order (spec #40) — retry once after a short delay.
 */

const RESEND_KEY = process.env.RESEND_API_KEY ?? '';
const FROM = process.env.RESEND_FROM ?? 'Green Gate <onboarding@resend.dev>';

export const emailConfigured = Boolean(RESEND_KEY);

const GREEN = '#16a34a';

/**
 * HTML-escape user-supplied text before it is placed in an email body.
 * Product/store names, buyer names and seller notes are typed by users; raw,
 * they could inject links or markup into mail sent under the Green Gate name.
 */
export function escapeHtml(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const esc = escapeHtml;

function shell(title: string, bodyHtml: string): string {
  return `
  <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color:#111827;">
    <div style="border-bottom:2px solid ${GREEN}; padding:16px 0; margin-bottom:16px;">
      <span style="font-size:18px; font-weight:700; letter-spacing:1px;">GREEN <span style="color:${GREEN};">GATE</span></span>
    </div>
    <h2 style="color:${GREEN}; font-size:18px; margin:0 0 12px;">${title}</h2>
    ${bodyHtml}
    <p style="color:#6b7280; font-size:12px; margin-top:24px; border-top:1px solid #e5e7eb; padding-top:12px;">
      Green Gate — multi-vendor marketplace. This is an automated message.
    </p>
  </div>`;
}

async function send(to: string, subject: string, html: string): Promise<boolean> {
  if (!emailConfigured) return false;
  const { trackApiUsage } = await import('@/lib/usage');
  trackApiUsage('resend');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: [to], subject, html }),
        // Hard ceiling: register/reset AWAIT this send, so a hung Resend
        // connection must never hold an auth request hostage.
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) return true;
      console.error('resend send failed:', res.status, await res.text());
    } catch (e) {
      console.error('resend send error:', e instanceof Error ? e.message : e);
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/**
 * System-watch alert (additive): sent by /api/cron/system-watch when a
 * monitored check fails for the first time (kind 'incident') and when it
 * recovers (kind 'recovery'). Never includes credential values.
 */
export async function sendSystemAlertEmail(params: {
  to: string;
  kind: 'incident' | 'recovery';
  check: string;
  detail: string;
  occurrences?: number;
  durationMinutes?: number;
}): Promise<boolean> {
  const incident = params.kind === 'incident';
  const color = incident ? '#b91c1c' : GREEN;
  const title = incident
    ? `⚠ System alert: ${esc(params.check)}`
    : `✓ Recovered: ${esc(params.check)}`;
  const body = `
    <div style="border-left:4px solid ${color}; padding:10px 14px; background:#f9fafb; margin:0 0 14px;">
      <p style="margin:0 0 6px;"><strong>${incident ? 'A monitored system check is FAILING' : 'A previously failing check has RECOVERED'}.</strong></p>
      <p style="margin:0; color:#374151;">Check: <strong>${esc(params.check)}</strong></p>
      <p style="margin:4px 0 0; color:#374151;">Detail: ${esc(params.detail)}</p>
      ${incident && params.occurrences ? `<p style="margin:4px 0 0; color:#374151;">Consecutive failed runs: ${params.occurrences}</p>` : ''}
      ${!incident && params.durationMinutes !== undefined ? `<p style="margin:4px 0 0; color:#374151;">Duration: ~${params.durationMinutes} minute(s)</p>` : ''}
      ${incident ? '<p style="margin:10px 0 0; color:#6b7280; font-size:12px;">Live status: admin console → System Monitor (polls every second).</p>' : ''}
    </div>`;
  return send(params.to, `${incident ? '⚠' : '✓'} Green Gate monitor — ${params.check}`, shell(title, body));
}

export async function sendVerificationEmail(params: { to: string; name: string; url: string }): Promise<boolean> {
  return send(
    params.to,
    'Verify your Green Gate account',
    shell(
      `Welcome to Green Gate, ${esc(params.name) || 'there'}!`,
      `<p>Confirm your email address to activate your account:</p>
       <p><a href="${params.url}" style="background:${GREEN}; color:#fff; padding:10px 18px; text-decoration:none; border-radius:6px; display:inline-block;">Verify email</a></p>
       <p style="color:#6b7280; font-size:13px;">Or paste this link into your browser:<br/>${params.url}</p>
       <p style="color:#6b7280; font-size:13px;">The link expires in 24 hours.</p>`,
    ),
  );
}

export async function sendPasswordResetEmail(params: { to: string; url: string }): Promise<boolean> {
  return send(
    params.to,
    'Reset your Green Gate password',
    shell(
      'Password reset requested',
      `<p>We received a request to reset the password for <strong>${esc(params.to)}</strong>.</p>
       <p><a href="${params.url}" style="background:${GREEN}; color:#fff; padding:10px 18px; text-decoration:none; border-radius:6px; display:inline-block;">Choose a new password</a></p>
       <p style="color:#6b7280; font-size:13px;">Or paste this link into your browser:<br/>${params.url}</p>
       <p style="color:#6b7280; font-size:13px;">The link expires in 1 hour. If you did not request this, you can safely ignore this email.</p>`,
    ),
  );
}

export async function sendOrderConfirmation(params: {
  to: string;
  buyerName: string;
  orderNumber: string;
  storeName: string;
  itemsText: string;
  total: string;
  instructionsHtml: string;
}): Promise<boolean> {
  return send(
    params.to,
    `Order ${params.orderNumber} received — Green Gate`,
    shell(
      `Thank you for your order, ${esc(params.buyerName)}!`,
      `<p>Your order with <strong>${esc(params.storeName)}</strong> has been received.</p>
       <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px; padding:16px; margin:16px 0;">
         <p style="margin:0 0 8px;"><strong>Order:</strong> ${params.orderNumber}</p>
         <div>${params.itemsText}</div>
         <p style="margin:12px 0 0;"><strong>Total:</strong> ${params.total}</p>
       </div>
       ${params.instructionsHtml}
       <p style="color:#6b7280; font-size:13px;">Track this order any time from your Green Gate account.</p>`,
    ),
  );
}

export async function sendSellerNewOrder(params: {
  to: string;
  storeName: string;
  orderNumber: string;
  itemsText: string;
  total: string;
  pinUrl?: string; // exact GPS delivery pin (Google Maps) — shown to the seller/courier when the buyer shares a real-time location
}): Promise<boolean> {
  return send(
    params.to,
    `New order ${params.orderNumber} — ${params.storeName}`,
    shell(
      'You have a new order',
      `<p><strong>${params.orderNumber}</strong> was placed on your store <strong>${esc(params.storeName)}</strong>.</p>
       <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px; padding:16px; margin:16px 0;">
         <div>${params.itemsText}</div>
         <p style="margin:12px 0 0;"><strong>Order value:</strong> ${params.total}</p>
       </div>
       ${params.pinUrl ? `<p style="margin:12px 0;"><strong>📍 Exact delivery pin:</strong> <a href="${params.pinUrl}">open the courier's map pin</a></p>` : ''}
       <p>Open your seller dashboard to confirm payment and manage fulfilment.</p>`,
    ),
  );
}

export async function sendOrderStatusEmail(params: {
  to: string;
  orderNumber: string;
  statusLabel: string;
  note?: string | null;
}): Promise<boolean> {
  return send(
    params.to,
    `Order ${params.orderNumber}: ${params.statusLabel} — Green Gate`,
    shell(
      `Order update: ${params.statusLabel}`,
      `<p>Order <strong>${params.orderNumber}</strong> is now <strong>${params.statusLabel}</strong>.</p>
       ${params.note ? `<p style="color:#374151;">${esc(params.note)}</p>` : ''}
       <p style="color:#6b7280; font-size:13px;">View the full timeline in your Green Gate account.</p>`,
    ),
  );
}

export async function sendStoreWelcome(params: { to: string; storeName: string; ownerName: string }): Promise<boolean> {
  return send(
    params.to,
    `Your store ${params.storeName} is live — Green Gate`,
    shell(
      `Welcome aboard, ${esc(params.ownerName)}!`,
      `<p><strong>${esc(params.storeName)}</strong> is now live on Green Gate.</p>
       <ul>
         <li>List products — every photo is checked and given a clean white studio background automatically.</li>
         <li>AI-generated product images are not permitted — use real photos of your stock.</li>
         <li>Track revenue, orders and traffic in your seller dashboard.</li>
       </ul>`,
    ),
  );
}

/**
 * Abandoned-checkout recovery: a single, gentle reminder for an order that
 * was placed but never paid (status pending_payment / awaiting_payment).
 * Sent at most once per order — the cron route records an orderEvent guard
 * before calling this, so a buyer is never spammed.
 */
export async function sendAbandonedCheckoutEmail(params: {
  to: string;
  buyerName: string;
  orderNumber: string;
  storeName: string;
  total: string;
  payUrl: string;
}): Promise<boolean> {
  return send(
    params.to,
    `Complete your payment — order ${params.orderNumber} is waiting — Green Gate`,
    shell(
      `${esc(params.buyerName)}, your order is almost yours`,
      `<p>Your order <strong>${params.orderNumber}</strong> from <strong>${esc(params.storeName)}</strong> for <strong>${params.total}</strong> was placed but not paid yet. Your items are reserved — payment completes the order and dispatch starts.</p>
       <p style="margin:20px 0;">
         <a href="${params.payUrl}" style="background:${GREEN}; color:#ffffff; padding:12px 22px; border-radius:8px; text-decoration:none; font-weight:700;">Pay ${params.total} securely in the app</a>
       </p>
       <p style="color:#6b7280; font-size:13px;">Payment happens inside Green Gate — card, PayFast, Ozow instant EFT or bank transfer. The button takes you straight to your order's secure payment page.</p>`,
    ),
  );
}
