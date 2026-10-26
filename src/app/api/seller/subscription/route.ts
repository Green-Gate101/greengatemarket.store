import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireStoreSeller, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { rateLimitShared, tooManyRequests } from '@/lib/rate-limit';
import {
  BILLING_SELECT, PLANS, SUBSCRIPTION_FEATURES, TRIAL_DAYS, isPlan, planPriceCents, platformYocoKey,
  startSubscriptionCheckout, storeAccess, verifyRecentPendingPayments,
} from '@/lib/subscription';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Seller subscription — status, plans, what is included and payment history
 * (GET); start a Yoco card payment for a plan (POST { plan }). Owner only.
 * GET also re-checks the store's recent pending payments with Yoco, so a
 * payment completed in another tab shows up as soon as the dashboard loads.
 */
export async function GET() {
  try {
    await bootstrap();
    const session = await requireStoreSeller();
    const found = await db.store.findUnique({ where: { userId: session.user.id }, select: { id: true } });
    if (!found) return Response.json({ error: 'Create your store first.' }, { status: 404 });
    await verifyRecentPendingPayments(found.id).catch(() => undefined);
    const [store, payments] = await Promise.all([
      db.store.findUnique({ where: { id: found.id }, select: BILLING_SELECT }),
      db.subscriptionPayment.findMany({
        where: { storeId: found.id },
        orderBy: { createdAt: 'desc' },
        take: 24,
        select: { reference: true, plan: true, amountCents: true, status: true, createdAt: true, paidAt: true, periodEnd: true },
      }),
    ]);
    return Response.json({
      access: storeAccess(store!),
      trialDays: TRIAL_DAYS,
      plans: PLANS.map((plan) => ({ id: plan, priceCents: planPriceCents(plan), period: plan === 'yearly' ? 'year' : 'month' })),
      features: SUBSCRIPTION_FEATURES,
      paymentsReady: Boolean(platformYocoKey()),
      payments: payments.map((p) => ({
        ...p,
        createdAt: p.createdAt.toISOString(),
        paidAt: p.paidAt?.toISOString() ?? null,
        periodEnd: p.periodEnd?.toISOString() ?? null,
      })),
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('subscription GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load your subscription.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireStoreSeller();
    const rl = await rateLimitShared(`subscription-start:${session.user.id}`, 10, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    let body: { plan?: unknown };
    try {
      // `null`, a list or a bare value reads as "no plan chosen" (400), never a crash.
      body = (((await req.json()) as unknown) ?? {}) as { plan?: unknown };
    } catch {
      return Response.json({ error: 'Choose a plan.' }, { status: 400 });
    }
    if (!isPlan(body.plan)) return Response.json({ error: 'Choose the monthly or the yearly plan.' }, { status: 400 });
    const baseUrl = (process.env.NEXTAUTH_URL ?? new URL(req.url).origin).replace(/\/$/, '');
    const started = await startSubscriptionCheckout({ userId: session.user.id, plan: body.plan, baseUrl });
    return Response.json(started, { status: 201 });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('subscription POST error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not start the payment. Please try again.' }, { status: 500 });
  }
}
