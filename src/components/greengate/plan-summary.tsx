'use client';

import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';

interface PlansData { trialDays: number; plans: { id: 'monthly' | 'yearly'; priceCents: number; period: string }[]; features: string[] }

const rand = (cents: number) => {
  // Formatted by hand (space between thousands, comma for cents — how South
  // Africans write money): some browsers ship without en-ZA number data and
  // printed "R6,999" instead of "R6 999".
  const whole = Math.floor(Math.abs(cents) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  const c = Math.abs(cents) % 100;
  return `${cents < 0 ? '-' : ''}R${whole}${c ? `,${String(c).padStart(2, '0')}` : ''}`;
};

/** Seller pricing in plain words, shown before a seller applies. */
export function PlanSummary() {
  const plans = useQuery<PlansData>({
    queryKey: ['plans'],
    queryFn: async () => {
      const res = await fetch('/api/plans');
      if (!res.ok) throw new Error('Could not load pricing');
      return res.json();
    },
    staleTime: 10 * 60_000,
  });
  if (!plans.data) return null;
  const { trialDays, features } = plans.data;
  const monthly = plans.data.plans.find((p) => p.id === 'monthly');
  const yearly = plans.data.plans.find((p) => p.id === 'yearly');
  return (
    <section className="mt-4 rounded-md border bg-secondary/50 p-3 text-xs" aria-label="Seller pricing" data-testid="plan-summary">
      <p className="text-sm font-semibold">
        Free for {trialDays} days from approval, then {monthly ? `${rand(monthly.priceCents)} a month` : ''}{monthly && yearly ? ' or ' : ''}{yearly ? `${rand(yearly.priceCents)} a year` : ''}.
      </p>
      <p className="mt-1 text-muted-foreground">No automatic debit — you pay by card when you choose to renew. If a subscription ends, your store pauses until you pay; nothing is deleted.</p>
      <details className="mt-2">
        <summary className="cursor-pointer font-semibold">What the subscription includes</summary>
        <ul className="mt-2 space-y-1">
          {features.map((f) => (
            <li key={f} className="flex items-start gap-2 text-muted-foreground">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
