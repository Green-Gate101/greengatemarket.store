import { PLANS, SUBSCRIPTION_FEATURES, TRIAL_DAYS, planPriceCents } from '@/lib/subscription';

export const dynamic = 'force-dynamic';

/** Public seller pricing: free trial, plans and what they include (shown before applying). */
export function GET() {
  return Response.json(
    {
      trialDays: TRIAL_DAYS,
      plans: PLANS.map((plan) => ({ id: plan, priceCents: planPriceCents(plan), period: plan === 'yearly' ? 'year' : 'month' })),
      features: SUBSCRIPTION_FEATURES,
    },
    { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
  );
}
