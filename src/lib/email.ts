/**
 * Transactional email via Resend (key verified against api.resend.com).
 * Emails are best-effort: a failure logs a warning and never blocks the
 * customer's order.
 */

const RESEND_KEY = process.env.RESEND_API_KEY ?? '';
const FROM = process.env.RESEND_FROM ?? 'Soko Market <onboarding@resend.dev>';

export const emailConfigured = Boolean(RESEND_KEY);

export async function sendOrderConfirmation(params: {
  to: string;
  buyerName: string;
  orderId: string;
  storeName: string;
  itemsText: string;
  total: string;
}): Promise<boolean> {
  if (!emailConfigured) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [params.to],
        subject: `Order ${params.orderId} confirmed — ${params.storeName}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
            <h2 style="color:#059669;">Thank you for your order, ${params.buyerName}!</h2>
            <p>Your order with <strong>${params.storeName}</strong> has been received.</p>
            <div style="background:#f6fef9;border:1px solid #d1fae5;border-radius:8px;padding:16px;margin:16px 0;">
              <p style="margin:0 0 8px;"><strong>Order reference:</strong> ${params.orderId}</p>
              <div>${params.itemsText}</div>
              <p style="margin:12px 0 0;"><strong>Total paid:</strong> ${params.total}</p>
            </div>
            <p style="color:#6b7280;font-size:13px;">The seller has been notified and your parcel will be dispatched via courier. Keep this email as your proof of purchase.</p>
          </div>
        `,
      }),
    });
    if (!res.ok) {
      console.error('resend send failed:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('resend send error:', e instanceof Error ? e.message : e);
    return false;
  }
}

export async function sendSellerWelcome(params: { to: string; storeName: string; ownerName: string }): Promise<boolean> {
  if (!emailConfigured) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [params.to],
        subject: `Welcome to Soko Market, ${params.storeName}!`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
            <h2 style="color:#059669;">Welcome aboard, ${params.ownerName}!</h2>
            <p><strong>${params.storeName}</strong> is now live on Soko Market.</p>
            <ul>
              <li>Upload products — every photo is automatically cleaned onto a white studio background.</li>
              <li>Track revenue, orders and units sold in your seller dashboard.</li>
              <li>Nationwide courier shipping is calculated at checkout.</li>
            </ul>
          </div>
        `,
      }),
    });
    return res.ok;
  } catch (e) {
    console.error('resend welcome error:', e instanceof Error ? e.message : e);
    return false;
  }
}
