import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { audit } from '@/lib/audit';
import { settleOrderPayment } from '@/lib/ggpay';
import { ozowSellerReady, ozowStatusPaid, ozowVerifyNotification } from '@/lib/seller-payments';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Ozow notify webhook (server-to-server).
 *
 * Ozow posts the transaction outcome here. An order is confirmed ONLY on
 * verified proof, in this order of strength:
 *   1. an authenticated status query to Ozow (when the seller added an API key)
 *   2. the SHA-512 notification hash, verified with the SELLER's private key
 * A payload with neither positive proof is recorded for audit and ignored —
 * the order stays awaiting_payment (fail closed, never faked).
 *
 * Amount guard: the notified amount must match the order total exactly.
 */
export async function POST(req: NextRequest) {
  let verified = false; // flips true only after positive payment proof
  try {
    // Public webhook — cheap-to-hammer guard (mirrors the PayFast ITN one).
    const rl = rateLimit(`ozow-notify:${clientIp(req)}`, 60, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    await bootstrap();

    const raw = await req.text();
    let fields: Record<string, string> = {};
    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const json: unknown = JSON.parse(raw);
      if (json && typeof json === 'object') {
        for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
          fields[k] = v === null || v === undefined ? '' : String(v);
        }
      }
    } else {
      for (const pair of raw.split('&')) {
        if (!pair) continue;
        const idx = pair.indexOf('=');
        const k = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
        const v = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
        fields[k] = v;
      }
    }
    if (!raw || Object.keys(fields).length === 0) return new Response('bad payload', { status: 400 });

    // Case-insensitive accessors (Ozow payloads mix casing across versions).
    const get = (...keys: string[]) => {
      for (const k of keys) {
        const v = fields[k];
        if (v !== undefined && v !== '') return v;
      }
      return '';
    };
    const reference = get('TransactionReference');
    const transactionId = get('TransactionId', 'TransactionID');
    const status = get('Status');
    const amount = get('Amount');

    if (!reference) {
      await audit({ actorEmail: 'ozow-notify', action: 'ozow_notify_rejected', target: transactionId || null, detail: 'missing TransactionReference' }).catch(() => undefined);
      return new Response('missing reference', { status: 200 });
    }

    const order = await db.order.findUnique({
      where: { number: reference },
      select: {
        id: true, number: true, status: true, paymentStatus: true, paymentRef: true, totalCents: true,
        buyerId: true, buyerEmail: true, buyerName: true, subtotalCents: true, ozowTransactionId: true,
        store: { select: { id: true, name: true, ozowSiteCode: true, ozowPrivateKeyEnc: true, ozowApiKeyEnc: true } },
      },
    });
    if (!order || !order.store) return new Response('unknown order', { status: 200 });

    if (order.paymentStatus !== 'awaiting_payment') return new Response('already processed', { status: 200 });

    // Amount guard: notified amount must equal the order total (2 decimals).
    const expected = (order.totalCents / 100).toFixed(2);
    if (amount && amount !== expected) {
      await audit({ actorEmail: 'ozow-notify', action: 'ozow_notify_amount_mismatch', target: order.number, detail: `${amount} vs ${expected}` }).catch(() => undefined);
      return new Response('amount mismatch', { status: 200 });
    }

    if (status !== 'Complete') return new Response('ignored', { status: 200 });

    // Proof 1: authenticated status query (strongest).
    let confirmed = false;
    if (ozowSellerReady(order.store)) {
      const statusCheck = await ozowStatusPaid(order.number, order.store, transactionId || order.ozowTransactionId || undefined, order.totalCents);
      if (statusCheck?.paid) confirmed = true;
    }
    // Proof 2: notification hash with the seller's private key.
    if (!confirmed) {
      const hashCheck = ozowVerifyNotification(fields, order.store);
      if (!hashCheck.ok) {
        await audit({ actorEmail: 'ozow-notify', action: 'ozow_notify_unverified', target: order.number, detail: `${hashCheck.reason ?? 'no proof'} · tx ${transactionId || 'n/a'}` }).catch(() => undefined);
        return new Response('unverified', { status: 200 });
      }
      confirmed = true;
    }

    if (!confirmed) return new Response('unverified', { status: 200 });
    verified = true;

    // Keep the transaction id for the polling status query — written only
    // AFTER positive proof, so an unverified caller can never stamp an
    // arbitrary transaction id onto an order.
    if (transactionId && order.ozowTransactionId !== transactionId) {
      await db.order.update({ where: { id: order.id }, data: { ozowTransactionId: transactionId } });
    }

    const reference2 = `OZOW-${transactionId || order.number}`;
    await settleOrderPayment(
      {
        id: order.id, number: order.number, status: order.status, paymentStatus: order.paymentStatus,
        buyerId: order.buyerId, buyerEmail: order.buyerEmail, storeId: order.store.id,
        subtotalCents: order.subtotalCents, totalCents: order.totalCents,
      },
      { provider: 'ozow', method: 'instant_eft', reference: reference2 },
    );
    await audit({ actorEmail: 'ozow-notify', action: 'payment_confirmed_ozow', target: order.number, detail: `ref ${reference2}` }).catch(() => undefined);
    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('ozow notify error:', e instanceof Error ? e.message : e);
    // Pre-verification rejections are permanent (200 — Ozow must not retry
    // them); post-verification failures are transient (5xx so Ozow retries
    // and a genuinely paid order is never stranded awaiting_payment).
    return new Response('error', { status: verified ? 500 : 200 });
  }
}
