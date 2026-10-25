'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { formatMoney, type EftDetailsDto } from '@/lib/types';
import { BankLogo, PayFastLogo, OzowLogo } from './payment-logos';
import { readJson } from '@/lib/utils';

/**
 * Pay by EFT: the seller's real bank details for THIS order (sent by the
 * server only to the order's buyer while it awaits payment), with the exact
 * amount and the order number as reference. Without details there is no EFT
 * option to offer, and the buyer is told so plainly.
 */
export function EftInstructions({ orderNumber, totalCents, eft }: { orderNumber: string; totalCents: number; eft?: EftDetailsDto | null }) {
  if (!eft) {
    return (
      <p className="rounded-md bg-secondary p-3 text-xs text-muted-foreground">
        <span aria-hidden="true" className="mr-1.5"><BankLogo /></span>EFT is not available for this seller yet (no bank details on file) — please use one of the other payment options.
      </p>
    );
  }
  const row = (label: string, value: string, mono = false) => (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono font-semibold' : 'font-medium'}>{value}</dd>
    </>
  );
  return (
    <div className="rounded-md border bg-secondary p-3 text-xs" data-testid={`eft-${orderNumber}`}>
      <p className="font-semibold">
        <span aria-hidden="true" className="mr-1.5"><BankLogo /></span>Pay by EFT (bank transfer) to the seller
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {row('Bank', eft.bankName)}
        {row('Account holder', eft.accountHolder)}
        {row('Account number', eft.accountNumber, true)}
        {eft.branchCode && row('Branch code', eft.branchCode, true)}
        {eft.accountType && row('Account type', eft.accountType.charAt(0).toUpperCase() + eft.accountType.slice(1))}
        {row('Amount', formatMoney(totalCents))}
        {row('Reference', orderNumber, true)}
      </dl>
      <p className="mt-2 text-muted-foreground">
        Use the order number as your payment reference. The seller confirms the money has arrived and your order updates automatically.
      </p>
    </div>
  );
}

/**
 * Seller-owned processor payments — the buyer pays with the SELLER'S OWN
 * PayFast or Ozow account on the processor's secure payment page:
 *  - PayFast: a server-signed form is posted top-level to www.payfast.co.za
 *    (card or instant EFT).
 *  - Ozow: the server creates the payment request and the buyer goes to the
 *    Ozow page it returns (instant EFT from their bank).
 * Neither processor may be shown inside a frame, so both are full-page
 * redirects; the buyer comes straight back to their orders.
 *
 * Success is decided server-side only (verified PayFast ITN + PayFast's own
 * confirmation; hash-verified Ozow notification + authenticated status
 * query). When the buyer returns, the order's status is checked once so a
 * completed payment shows immediately even if the notification is late.
 */

type PayMethod = 'payfast' | 'ozow';

interface InitiateResponse {
  ok?: boolean;
  kind?: 'payfast_redirect' | 'ozow_redirect';
  error?: string;
  submission?: { name: string; value: string }[];
  processUrl?: string;
  paymentUrl?: string;
}

/** Posts the signed fields to PayFast in the top window (never a frame). */
function postToPayfast(processUrl: string, fields: { name: string; value: string }[]) {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = processUrl;
  for (const f of fields) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = f.name;
    input.value = f.value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

export function SellerPayButtons({
  orderNumber,
  payfastReady,
  ozowReady,
}: {
  orderNumber: string;
  payfastReady?: boolean;
  ozowReady?: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PayMethod | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Back from PayFast/Ozow: one server-truth check (it also runs Ozow's
  // authenticated status query), so a finished payment shows straight away.
  useEffect(() => {
    if (!payfastReady && !ozowReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/payments/seller/status?number=${encodeURIComponent(orderNumber)}`);
        if (!res.ok || cancelled) return;
        const d = (await readJson(res)) as { paymentStatus?: string };
        if (d.paymentStatus === 'paid') {
          queryClient.invalidateQueries({ queryKey: ['orders'] });
          queryClient.invalidateQueries({ queryKey: ['order'] });
          queryClient.invalidateQueries({ queryKey: ['notifications'] });
        }
      } catch {
        /* the order list stays as loaded — webhooks still settle it */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orderNumber, payfastReady, ozowReady, queryClient]);

  if (!payfastReady && !ozowReady) return null;

  const start = async (method: PayMethod) => {
    setPending(method);
    setError(null);
    try {
      const res = await fetch('/api/payments/seller/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber, method }),
      });
      const data = (await readJson(res)) as InitiateResponse;
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'This payment method could not be started — please use another option.');
        setPending(null);
        return;
      }
      if (method === 'payfast' && data.processUrl && data.submission) {
        postToPayfast(data.processUrl, data.submission);
        return; // leaving for PayFast — keep the spinner
      }
      if (method === 'ozow' && data.paymentUrl) {
        window.location.assign(data.paymentUrl);
        return; // leaving for Ozow — keep the spinner
      }
      setError('The payment page could not be opened — please use another option.');
      setPending(null);
    } catch {
      setError('Network problem — please try again or use another payment method.');
      toast({ title: 'Payment', description: 'Network problem — please try again.', variant: 'destructive' });
      setPending(null);
    }
  };

  return (
    <div className="rounded-lg border p-4" data-testid={`sellerpay-${orderNumber}`}>
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Lock className="h-4 w-4 text-primary" aria-hidden /> Pay securely with the seller&apos;s payment provider
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        You&apos;ll pay on the provider&apos;s secure page and come straight back here. The total includes delivery.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {payfastReady && (
          <Button type="button" variant="outline" className="h-auto min-h-11 w-full justify-start whitespace-normal py-2 text-left" disabled={pending !== null} onClick={() => start('payfast')}>
            {pending === 'payfast' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <span aria-hidden="true" className="mr-1.5"><PayFastLogo /></span>}
            PayFast — card or instant EFT
          </Button>
        )}
        {ozowReady && (
          <Button type="button" variant="outline" className="h-auto min-h-11 w-full justify-start whitespace-normal py-2 text-left" disabled={pending !== null} onClick={() => start('ozow')}>
            {pending === 'ozow' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <span aria-hidden="true" className="mr-1.5"><OzowLogo /></span>}
            Ozow — pay by bank (instant EFT)
          </Button>
        )}
      </div>
      {error && (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
