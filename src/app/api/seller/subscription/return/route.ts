import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { verifySubscriptionPayment } from '@/lib/subscription';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Where Yoco sends the seller back after paying (or failing). The browser's
 * arrival proves nothing: the payment is credited only if Green Gate's
 * server confirms it with Yoco (checkout stored on this payment, exact
 * amount). Always redirects to the dashboard with the outcome — a fixed
 * in-app destination, never one taken from the request.
 */
export async function GET(req: NextRequest) {
  const base = (process.env.NEXTAUTH_URL ?? new URL(req.url).origin).replace(/\/$/, '');
  const go = (state: string) => Response.redirect(`${base}/#/dashboard?billing=${state}`, 303);
  try {
    const rl = rateLimit(`subscription-return:${clientIp(req)}`, 60, 60_000);
    if (!rl.allowed) return go('pending');
    await bootstrap();
    const ref = String(new URL(req.url).searchParams.get('ref') ?? '').trim();
    if (!/^SUB-[A-Z0-9]{8}$/.test(ref)) return go('unknown');
    const payment = await db.subscriptionPayment.findUnique({ where: { reference: ref } });
    if (!payment) return go('unknown');
    const result = await verifySubscriptionPayment(payment);
    return go(result === 'unavailable' ? 'pending' : result);
  } catch (e) {
    console.error('subscription return error:', e instanceof Error ? e.message : e);
    return go('pending');
  }
}
