'use client';

import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, CalendarClock, Check, CreditCard, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { readJson } from '@/lib/utils';

export type AccessState = 'free' | 'trial' | 'paid' | 'expired' | 'not_active';

interface SubscriptionData {
  access: { state: AccessState; accessUntil: string | null; trialEndsAt: string | null; paidUntil: string | null; plan: 'monthly' | 'yearly' | null; daysLeft: number | null };
  trialDays: number;
  plans: { id: 'monthly' | 'yearly'; priceCents: number; period: 'month' | 'year' }[];
  features: string[];
  paymentsReady: boolean;
  payments: { reference: string; plan: string; amountCents: number; status: string; createdAt: string; paidAt: string | null; periodEnd: string | null }[];
}

const rand = (cents: number) => {
  // Formatted by hand (space between thousands, comma for cents — how South
  // Africans write money): some browsers ship without en-ZA number data and
  // printed "R6,999" instead of "R6 999".
  const whole = Math.floor(Math.abs(cents) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  const c = Math.abs(cents) % 100;
  return `${cents < 0 ? '-' : ''}R${whole}${c ? `,${String(c).padStart(2, '0')}` : ''}`;
};
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' }) : '—';

const BILLING_MESSAGES: Record<string, { title: string; description: string; destructive?: boolean }> = {
  paid: { title: 'Payment received', description: 'Thank you — your subscription is active.' },
  pending: { title: 'Payment being confirmed', description: 'Yoco is still confirming your payment. This page updates as soon as it is confirmed.' },
  failed: { title: 'Payment not completed', description: 'Nothing was charged. You can try again with another card.', destructive: true },
  cancelled: { title: 'Payment cancelled', description: 'Nothing was charged.' },
  unknown: { title: 'Payment not found', description: 'We could not find that payment. If money left your account, message Green Gate below.', destructive: true },
};

/**
 * Seller subscription: status (trial / paid / free / paused), the two plans,
 * everything a subscription includes, and payment history. Paying opens
 * Yoco's secure card page; the subscription only counts after Green Gate's
 * server confirms the payment with Yoco.
 */
export function SubscriptionCard({ accessState }: { accessState?: AccessState }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const sub = useQuery<SubscriptionData>({
    queryKey: ['subscription'],
    queryFn: async () => {
      const res = await fetch('/api/seller/subscription');
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error ?? 'Could not load your subscription');
      return data;
    },
    // Watch closely only while a payment is in progress (started in the last
    // 30 minutes); an abandoned checkout is left to the next visit and the daily job.
    refetchInterval: (q) => ((q.state.data as SubscriptionData | undefined)?.payments.some((p) => p.status === 'pending' && Date.now() - new Date(p.createdAt).getTime() < 30 * 60_000) ? 15_000 : false),
  });

  // Coming back from Yoco: tell the seller the outcome once, then tidy the address.
  const shown = useRef(false);
  useEffect(() => {
    if (shown.current || typeof window === 'undefined') return;
    const m = window.location.hash.match(/[?&]billing=([a-z]+)/);
    if (!m) return;
    shown.current = true;
    const msg = BILLING_MESSAGES[m[1]];
    if (msg) toast({ title: msg.title, description: msg.description, variant: msg.destructive ? 'destructive' : undefined });
    try {
      window.history.replaceState(null, '', '#/dashboard');
    } catch {
      /* old browsers: leaving the flag in the address is harmless */
    }
  }, [toast]);

  // A payment confirmed while this page was open (or a re-check on load)
  // changes what the dashboard may show — refresh the store data.
  const state = sub.data?.access.state;
  useEffect(() => {
    if (state && accessState && state !== accessState) void queryClient.invalidateQueries({ queryKey: ['my-store'] });
  }, [state, accessState, queryClient]);

  const pay = useMutation({
    mutationFn: async (plan: 'monthly' | 'yearly') => {
      const res = await fetch('/api/seller/subscription', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error ?? 'Could not start the payment.');
      return data as { redirectUrl: string };
    },
    onSuccess: (d) => {
      // Yoco's secure page must be a full, top-level page (never framed).
      window.location.assign(d.redirectUrl);
    },
    onError: (e: Error) => toast({ title: 'Subscription', description: e.message, variant: 'destructive' }),
  });

  if (sub.isPending) {
    return <section className="mt-6 rounded-lg border bg-card p-4 sm:p-6"><Skeleton className="h-24 w-full" /></section>;
  }
  if (sub.isError || !sub.data) {
    return (
      <section className="mt-6 flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4 text-sm" role="alert">
        <span className="flex-1">We could not load your subscription.</span>
        <Button size="sm" variant="outline" onClick={() => void sub.refetch()}>Try again</Button>
      </section>
    );
  }

  const { access, plans, features, paymentsReady, payments, trialDays } = sub.data;
  const expired = access.state === 'expired';
  const canPay = access.state !== 'free' && access.state !== 'not_active';
  // A payment in progress (an older unfinished checkout just shows in the history).
  const pending = payments.find((p) => p.status === 'pending' && Date.now() - new Date(p.createdAt).getTime() < 30 * 60_000);

  return (
    <section
      className={`mt-6 rounded-lg border p-4 sm:p-6 ${expired ? 'border-destructive/40 bg-destructive/5' : 'bg-card'}`}
      aria-labelledby="subscription-heading"
      data-testid="subscription-card"
      data-state={access.state}
    >
      <h2 id="subscription-heading" className="flex items-center gap-2 text-lg font-bold">
        {expired ? <Lock className="h-5 w-5 text-destructive" aria-hidden /> : <BadgeCheck className="h-5 w-5 text-primary" aria-hidden />}
        Your Green Gate subscription
      </h2>

      <p className="mt-1 text-sm" data-testid="subscription-status">
        {access.state === 'trial' && <>Free trial — <strong>{access.daysLeft} day{access.daysLeft === 1 ? '' : 's'} left</strong> (ends {day(access.accessUntil)}). Subscribe any time; paid time starts after your trial.</>}
        {access.state === 'paid' && <>Active — paid until <strong>{day(access.accessUntil)}</strong>{access.plan ? ` (${access.plan} plan)` : ''}. Paying again adds time after this date.</>}
        {access.state === 'free' && <>Free access — granted by Green Gate. No payment is needed.</>}
        {access.state === 'not_active' && <>Your {trialDays}-day free trial starts the day your store is approved.</>}
        {expired && <><strong className="text-destructive">Your subscription has ended.</strong> Your store and products are hidden from buyers until you pay — everything comes back instantly afterwards. Orders already paid can still be fulfilled below.</>}
      </p>

      {pending && (
        <p className="mt-2 flex flex-wrap items-center gap-2 rounded-md border bg-secondary p-2 text-xs" role="status">
          <CalendarClock className="h-4 w-4 shrink-0" aria-hidden />
          <span className="flex-1">Payment {pending.reference} is being confirmed with Yoco — this updates by itself.</span>
          <Button size="sm" variant="outline" onClick={() => void sub.refetch()} disabled={sub.isFetching}>{sub.isFetching ? 'Checking…' : 'Check now'}</Button>
        </p>
      )}

      {canPay && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          {plans.map((p) => (
            <div key={p.id} className="rounded-md border bg-background p-3">
              <p className="text-sm font-semibold">{p.id === 'yearly' ? 'Yearly' : 'Monthly'}</p>
              <p className="mt-0.5 text-2xl font-bold">{rand(p.priceCents)}<span className="text-sm font-normal text-muted-foreground"> / {p.period}</span></p>
              <Button
                className="mt-2 h-auto min-h-10 w-full whitespace-normal"
                onClick={() => pay.mutate(p.id)}
                disabled={!paymentsReady || pay.isPending}
                data-testid={`pay-${p.id}`}
              >
                <CreditCard className="h-4 w-4 shrink-0" aria-hidden />
                {pay.isPending && pay.variables === p.id ? 'Opening Yoco…' : `Pay ${rand(p.priceCents)} by card`}
              </Button>
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground sm:col-span-2">
            {paymentsReady
              ? 'You pay on Yoco’s secure card page (Visa and Mastercard). No automatic debit — you choose when to renew, and we remind you 3 days before your time runs out.'
              : 'Card payments for subscriptions are being switched on — message Green Gate below if you want to pay now.'}
          </p>
        </div>
      )}

      <details className="mt-4 group" open={access.state === 'not_active' || expired}>
        <summary className="cursor-pointer text-sm font-semibold">What your subscription includes</summary>
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {features.map((f) => (
            <li key={f} className="flex items-start gap-2 text-xs text-muted-foreground">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </details>

      {payments.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-semibold">Payment history</summary>
          <ul className="mt-2 divide-y rounded-md border text-xs" data-testid="subscription-payments">
            {payments.map((p) => (
              <li key={p.reference} className="flex flex-wrap items-center justify-between gap-2 p-2">
                <span className="font-mono">{p.reference}</span>
                <span>{p.plan === 'yearly' ? 'Yearly' : 'Monthly'} · {rand(p.amountCents)}</span>
                <span className={p.status === 'paid' ? 'font-semibold text-primary' : p.status === 'pending' ? '' : 'text-muted-foreground'}>
                  {p.status === 'paid' ? `Paid ${day(p.paidAt)}${p.periodEnd ? ` · until ${day(p.periodEnd)}` : ''}` : p.status === 'pending' ? 'Being confirmed' : p.status === 'failed' ? 'Not completed' : 'Cancelled'}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
