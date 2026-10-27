'use client';

import { useQuery } from '@tanstack/react-query';
import { Banknote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime } from '@/lib/types';
import { readJson } from '@/lib/utils';

interface PayoutDto {
  id: string; reference: string; orderNumber: string;
  netCents: number; netLabel: string;
  status: 'pending' | 'processing' | 'paid';
  escrow: 'held' | 'released' | 'refunded';
  courierStatus: string | null;
  courierBookedAt: string | null; courierTrackingRef: string | null;
  releasedAt: string | null; paidAt: string | null;
  destination: string; createdAt: string;
}

interface EarningsDto {
  storeName: string;
  heldCents: number; heldLabel: string;
  releasedCents: number; releasedLabel: string;
  paidCents: number; paidLabel: string;
  payouts: PayoutDto[];
}

const escrowBadge = (escrow: PayoutDto['escrow']) =>
  escrow === 'released' ? <Badge className="bg-primary/15 text-primary" variant="secondary">Released</Badge>
  : escrow === 'refunded' ? <Badge variant="outline" className="border-destructive/40 text-destructive">Refunded</Badge>
  : <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400">In escrow</Badge>;

// Same look as the status badges on the Payouts card.
const statusBadge = (status: PayoutDto['status']) =>
  status === 'paid' ? <Badge className="bg-primary/15 text-primary" variant="secondary">paid</Badge>
  : status === 'processing' ? <Badge variant="outline" className="border-primary/40 text-primary">processing</Badge>
  : <Badge variant="secondary">pending</Badge>;

// Under held rows: what is blocking the release. A booking failure shows the
// honest reason the courier gave (everything after "booking_failed:").
const courierNote = (p: PayoutDto): string => {
  if (p.courierStatus?.startsWith('booking_failed')) {
    const idx = p.courierStatus.indexOf(':');
    const reason = idx >= 0 ? p.courierStatus.slice(idx + 1).trim() : '';
    return `Courier booking failed — ${reason || 'The Courier Guy could not book this shipment'}`;
  }
  return `Waiting for The Courier Guy to confirm collection${p.courierTrackingRef ? ` · tracking ${p.courierTrackingRef}` : ''}`;
};

// The most meaningful date for the row: when it was paid, else when it was
// released from escrow, else when the buyer paid the order.
const dateLine = (p: PayoutDto): string =>
  p.paidAt ? `Paid ${formatDateTime(p.paidAt)}`
  : p.releasedAt ? `Released ${formatDateTime(p.releasedAt)}`
  : `Queued ${formatDateTime(p.createdAt)}`;

/**
 * EarningsCard — the seller's side of the escrow wallet (Amazon/Takealot-style
 * clarity on where their money is). When a buyer pays an order in-app, the
 * seller's earnings are HELD in escrow until The Courier Guy confirms
 * collection, then RELEASED and queued for the payout run, then PAID out to
 * the bank account configured on the Payouts card below. Read-only view —
 * the numbers come from the same payout rows the marketplace's Finance
 * view sees.
 */
export function EarningsCard() {
  const earnings = useQuery<EarningsDto>({
    queryKey: ['seller-earnings'],
    queryFn: async () => {
      const res = await fetch('/api/seller/earnings');
      if (!res.ok) throw new Error('Could not load your earnings');
      return readJson(res);
    },
  });

  return (
    <section className="mt-8 rounded-lg border bg-card p-4 sm:p-6" aria-labelledby="earnings-heading" data-testid="earnings-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="earnings-heading" className="flex items-center gap-2 text-lg font-bold">
          <Banknote className="h-5 w-5 text-primary" aria-hidden /> Earnings
        </h2>
        <Button size="sm" variant="ghost" onClick={() => void earnings.refetch()} disabled={earnings.isFetching}>
          {earnings.isFetching ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Buyers pay in the app and your money moves through escrow: held until The Courier Guy confirms collection, then released for payout and paid to your bank account.
      </p>

      {earnings.isPending ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-3" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
        </div>
      ) : earnings.isError ? (
        <p className="mt-4 text-xs text-destructive">Could not load your earnings. <button className="underline" onClick={() => earnings.refetch()}>Try again</button></p>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Held in escrow</p>
              <p className="mt-1 text-xl font-bold text-amber-700 dark:text-amber-400">{earnings.data!.heldLabel}</p>
              <p className="text-[11px] text-muted-foreground">Until the courier confirms collection</p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Released — awaiting payout</p>
              <p className="mt-1 text-xl font-bold text-primary">{earnings.data!.releasedLabel}</p>
              <p className="text-[11px] text-muted-foreground">Queued for the next payout run</p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Paid out</p>
              <p className="mt-1 text-xl font-bold">{earnings.data!.paidLabel}</p>
              <p className="text-[11px] text-muted-foreground">Already sent to your payout account</p>
            </div>
          </div>

          {earnings.data?.payouts.length ? (
            <ul className="mt-4 max-h-96 space-y-2 overflow-y-auto">
              {earnings.data!.payouts.map((p) => (
                <li key={p.id} className="rounded-md border p-3 text-sm" data-testid="earning-row">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 font-mono font-bold">
                      {p.orderNumber || '—'}
                      <span className="ml-2 font-sans text-xs font-normal text-muted-foreground">{p.reference}</span>
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {escrowBadge(p.escrow)}
                      {statusBadge(p.status)}
                      <span className="font-semibold">{p.netLabel}</span>
                    </div>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{p.destination} · {dateLine(p)}</p>
                  {p.escrow === 'held' && <p className="mt-1 text-xs text-muted-foreground">{courierNote(p)}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-xs text-muted-foreground">No earnings yet — they appear the moment a buyer pays for one of your products in-app.</p>
          )}
        </>
      )}
    </section>
  );
}
