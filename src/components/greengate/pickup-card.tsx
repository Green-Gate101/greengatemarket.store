'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { readJson } from '@/lib/utils';
import { PICKUP_ETAS, PICKUP_INFO, PICKUP_KINDS, etaLabel, type PickupKind } from '@/lib/pickup';

export interface PickupFields {
  pickupPaxiCents?: number | null;
  pickupPaxiEta?: string | null;
  pickupPudoCents?: number | null;
  pickupPudoEta?: string | null;
}

interface Row { on: boolean; price: string; eta: string }

const rands = (cents: number) => (cents / 100).toFixed(2);

/**
 * Seller dashboard: offer collection at PAXI points and/or Pudo lockers next
 * to courier delivery. The seller sets what buyers pay and the delivery time
 * they book; the suggestions are the providers' published prices.
 */
export function PickupPointsCard({ store }: { store: PickupFields }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const initial = (kind: PickupKind): Row => {
    const cents = kind === 'paxi' ? store.pickupPaxiCents : store.pickupPudoCents;
    const eta = kind === 'paxi' ? store.pickupPaxiEta : store.pickupPudoEta;
    return cents
      ? { on: true, price: rands(cents), eta: eta ?? PICKUP_INFO[kind].suggestedEta }
      : { on: false, price: rands(PICKUP_INFO[kind].suggestedCents), eta: PICKUP_INFO[kind].suggestedEta };
  };
  const [rows, setRows] = useState<Record<PickupKind, Row>>(() => ({ paxi: initial('paxi'), pudo: initial('pudo') }));
  const set = (kind: PickupKind, patch: Partial<Row>) => setRows((r) => ({ ...r, [kind]: { ...r[kind], ...patch } }));

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, { on: boolean; priceCents?: number; eta?: string }> = {};
      for (const kind of PICKUP_KINDS) {
        const r = rows[kind];
        body[kind] = r.on ? { on: true, priceCents: Math.round(Number(r.price.replace(',', '.')) * 100), eta: r.eta } : { on: false };
      }
      const res = await fetch('/api/seller/pickup', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await readJson(res);
      if (!res.ok) throw new Error(out.error ?? 'Could not save');
      return out;
    },
    onSuccess: () => {
      toast({ title: 'Pickup points saved', description: 'Buyers see these options at checkout when every seller in their cart offers them.' });
      queryClient.invalidateQueries({ queryKey: ['my-store'] });
    },
    onError: (e: Error) => toast({ title: 'Pickup points', description: e.message, variant: 'destructive' }),
  });

  return (
    <section className="mt-6 rounded-lg border bg-card p-4 sm:p-6" aria-labelledby="pickup-heading" data-testid="pickup-card">
      <h2 id="pickup-heading" className="flex items-center gap-2 text-lg font-bold">
        <MapPin className="h-5 w-5 text-primary" aria-hidden /> Pickup points
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Let buyers collect at a PAXI point or a Pudo locker — often cheaper than door delivery. You set the price and delivery time; after an order you send the parcel to the point the buyer chose.
      </p>
      <div className="mt-4 space-y-4">
        {PICKUP_KINDS.map((kind) => {
          const info = PICKUP_INFO[kind];
          const r = rows[kind];
          return (
            <div key={kind} className="rounded-md border p-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                <Checkbox id={`pickup-${kind}-on`} checked={r.on} onCheckedChange={(v) => set(kind, { on: v === true })} />
                {info.label}
              </label>
              {r.on && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor={`pickup-${kind}-price`} className="text-xs">Price buyers pay (R)</Label>
                    <Input id={`pickup-${kind}-price`} inputMode="decimal" value={r.price} onChange={(e) => set(kind, { price: e.target.value.replace(/[^\d.,]/g, '').slice(0, 8) })} />
                  </div>
                  <div>
                    <Label htmlFor={`pickup-${kind}-eta`} className="text-xs">Delivery time you book</Label>
                    <select
                      id={`pickup-${kind}-eta`}
                      className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none"
                      value={r.eta}
                      onChange={(e) => set(kind, { eta: e.target.value })}
                    >
                      {PICKUP_ETAS.map((eta) => <option key={eta} value={eta}>{etaLabel(eta)}</option>)}
                    </select>
                  </div>
                  <p className="text-[11px] text-muted-foreground sm:col-span-2">
                    {info.suggestionNote} Prices change — check before you set yours.{' '}
                    <a href={info.finderUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{info.finderLabel} ↗</a>
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Button className="mt-4" onClick={() => save.mutate()} disabled={save.isPending} data-testid="pickup-save">
        {save.isPending ? 'Saving…' : 'Save pickup points'}
      </Button>
    </section>
  );
}
