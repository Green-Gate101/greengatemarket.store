'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TicketPercent } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { readJson } from '@/lib/utils';

interface CodeDto {
  id: string; code: string; percentOff: number | null; amountOffCents: number | null;
  minSubtotalCents: number; firstOrderOnly: boolean; maxUses: number | null; usedCount: number;
  expiresAt: string | null; active: boolean; disabledByAdmin: boolean; label: string; conditions: string[];
}

const cents = (rands: string) => Math.round(Number(rands.replace(',', '.')) * 100);

/**
 * Seller dashboard: the store's own discount codes (the seller pays for the
 * discount — it comes off their items, never delivery). Buyers enter a code
 * in the cart; the server checks every rule at checkout.
 */
export function DiscountCodesCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const codes = useQuery<{ codes: CodeDto[] }>({
    queryKey: ['seller-discounts'],
    queryFn: async () => {
      const res = await fetch('/api/seller/discounts');
      if (!res.ok) throw new Error('Could not load your codes');
      return readJson(res);
    },
  });

  const [code, setCode] = useState('');
  const [kind, setKind] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('10');
  const [minSpend, setMinSpend] = useState('');
  const [firstOrderOnly, setFirstOrderOnly] = useState(false);
  const [maxUses, setMaxUses] = useState('');
  const [expiresOn, setExpiresOn] = useState('');

  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/seller/discounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          ...(kind === 'percent' ? { percentOff: Math.round(Number(value)) } : { amountOffCents: cents(value) }),
          minSubtotalCents: minSpend ? cents(minSpend) : 0,
          firstOrderOnly,
          maxUses: maxUses ? Math.round(Number(maxUses)) : null,
          expiresOn: expiresOn || null,
        }),
      });
      const out = await readJson(res);
      if (!res.ok) throw new Error(out.error ?? 'Could not create the code');
      return out;
    },
    onSuccess: () => {
      toast({ title: 'Code created', description: 'Share it with buyers — they enter it in their cart.' });
      setCode('');
      setMinSpend('');
      setMaxUses('');
      setExpiresOn('');
      setFirstOrderOnly(false);
      queryClient.invalidateQueries({ queryKey: ['seller-discounts'] });
    },
    onError: (e: Error) => toast({ title: 'Discount code', description: e.message, variant: 'destructive' }),
  });

  const toggle = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const res = await fetch('/api/seller/discounts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, active }) });
      const out = await readJson(res);
      if (!res.ok) throw new Error(out.error ?? 'Could not update the code');
      return out;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['seller-discounts'] }),
    onError: (e: Error) => toast({ title: 'Discount code', description: e.message, variant: 'destructive' }),
  });

  return (
    <section className="mt-6 rounded-lg border bg-card p-4 sm:p-6" aria-labelledby="discounts-heading" data-testid="discounts-card">
      <h2 id="discounts-heading" className="flex items-center gap-2 text-lg font-bold">
        <TicketPercent className="h-5 w-5 text-primary" aria-hidden /> Discount codes
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Give buyers a code for your items — for example 10% off a first order. You pay for the discount: it comes off your items (never delivery) and buyers pay you less. Each buyer can use a code once.
      </p>

      <form
        className="mt-4 grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div>
          <Label htmlFor="dc-code" className="text-xs">Code</Label>
          <Input id="dc-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20))} placeholder="WELCOME10" required minLength={3} />
        </div>
        <div>
          <Label htmlFor="dc-value" className="text-xs">Discount</Label>
          <div className="mt-1 flex gap-2">
            <select
              aria-label="Discount type"
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs"
              value={kind}
              onChange={(e) => { setKind(e.target.value as 'percent' | 'amount'); setValue(e.target.value === 'percent' ? '10' : '50'); }}
            >
              <option value="percent">% off</option>
              <option value="amount">R off</option>
            </select>
            <Input id="dc-value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.,]/g, '').slice(0, 8))} required />
          </div>
        </div>
        <div>
          <Label htmlFor="dc-min" className="text-xs">Minimum spend at your store (R, optional)</Label>
          <Input id="dc-min" inputMode="decimal" value={minSpend} onChange={(e) => setMinSpend(e.target.value.replace(/[^\d.,]/g, '').slice(0, 9))} />
        </div>
        <div>
          <Label htmlFor="dc-uses" className="text-xs">Total uses (optional)</Label>
          <Input id="dc-uses" inputMode="numeric" value={maxUses} onChange={(e) => setMaxUses(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="No limit" />
        </div>
        <div>
          <Label htmlFor="dc-ends" className="text-xs">Last day (optional)</Label>
          <Input id="dc-ends" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </div>
        <label className="flex cursor-pointer items-center gap-2 self-end text-xs">
          <Checkbox id="dc-first" checked={firstOrderOnly} onCheckedChange={(v) => setFirstOrderOnly(v === true)} />
          Only for a buyer&apos;s first order on Green Gate
        </label>
        <Button type="submit" className="sm:col-span-2" disabled={create.isPending || code.length < 3}>
          {create.isPending ? 'Creating…' : 'Create code'}
        </Button>
      </form>

      <div className="mt-5">
        {codes.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : codes.isError ? (
          <p className="text-xs text-destructive">Could not load your codes. <button className="underline" onClick={() => codes.refetch()}>Try again</button></p>
        ) : (codes.data?.codes ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">No codes yet.</p>
        ) : (
          <ul className="space-y-2">
            {codes.data!.codes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm" data-testid="discount-row">
                <div className="min-w-0">
                  <p className="font-mono font-bold">{c.code} <span className="font-sans text-xs font-normal text-muted-foreground">· {c.label}</span></p>
                  <p className="text-xs text-muted-foreground">{c.conditions.join(' · ')} · used {c.usedCount}{c.maxUses !== null ? ` of ${c.maxUses}` : ''}</p>
                  {c.disabledByAdmin && <p className="text-xs text-destructive">Switched off by Green Gate.</p>}
                </div>
                <Button
                  size="sm"
                  variant={c.active ? 'outline' : 'default'}
                  disabled={toggle.isPending || (c.disabledByAdmin && !c.active)}
                  onClick={() => toggle.mutate({ id: c.id, active: !c.active })}
                >
                  {c.active ? 'Switch off' : 'Switch on'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
