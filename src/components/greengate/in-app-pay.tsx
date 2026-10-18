'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Banknote, Landmark, Loader2, Lock, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { formatMoney } from '@/lib/types';

/**
 * In-app processor payments — the buyer pays with the SELLER'S OWN PayFast or
 * Ozow account WITHOUT leaving the app:
 *  - PayFast Onsite: a signed form is submitted into an in-app lightbox
 *    frame; the buyer completes card / SiD instant EFT right there.
 *  - Ozow: the server-created transaction's bank-selection flow is rendered
 *    in an in-app frame (instant EFT).
 *
 * The frames are display-only: success is decided server-side (verified ITN /
 * notify webhooks, cross-checked status query) and detected here by polling
 * the payment-status endpoint — the same trust model as the rest of GGPay.
 * On any processor failure the buyer sees an honest message and the other
 * rails (GGPay card, Yoco card, payment link, bank transfer) stay available.
 */

type PayMethod = 'payfast' | 'ozow';

interface InitiateResponse {
  ok?: boolean;
  kind?: 'payfast_onsite' | 'ozow_frame';
  error?: string;
  amountCents?: number;
  submission?: { name: string; value: string }[];
  processUrl?: string;
  paymentUrl?: string;
  sandbox?: boolean;
  isTest?: boolean;
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
  const [modal, setModal] = useState<{ method: PayMethod; data: InitiateResponse } | null>(null);

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
      const data = (await res.json()) as InitiateResponse;
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'This payment method could not be started — please use another option.');
        setPending(null);
        return;
      }
      setModal({ method, data });
      setPending(null);
    } catch {
      setError('Network problem — please try again or use another payment method.');
      setPending(null);
    }
  };

  return (
    <div className="rounded-lg border p-4" data-testid={`sellerpay-${orderNumber}`}>
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Lock className="h-4 w-4 text-primary" aria-hidden /> Pay inside the app with the seller&apos;s own processor
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Secure payment completed right here — no redirects away. The total includes the The-Courier-Guy delivery fee.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {payfastReady && (
          <Button type="button" variant="outline" className="h-11 w-full justify-start" disabled={pending !== null} onClick={() => start('payfast')}>
            {pending === 'payfast' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Landmark className="mr-1.5 h-4 w-4" aria-hidden />}
            PayFast — card or instant EFT
          </Button>
        )}
        {ozowReady && (
          <Button type="button" variant="outline" className="h-11 w-full justify-start" disabled={pending !== null} onClick={() => start('ozow')}>
            {pending === 'ozow' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Banknote className="mr-1.5 h-4 w-4" aria-hidden />}
            Ozow — pay by bank (instant EFT)
          </Button>
        )}
      </div>
      {error && (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {modal && (
        <ProcessorPayModal
          orderNumber={orderNumber}
          method={modal.method}
          data={modal.data}
          onClose={() => setModal(null)}
          onPaid={() => {
            toast({ title: 'Payment successful', description: `Order ${orderNumber} is confirmed.` });
            queryClient.invalidateQueries({ queryKey: ['orders'] });
            queryClient.invalidateQueries({ queryKey: ['order'] });
            queryClient.invalidateQueries({ queryKey: ['notifications'] });
          }}
        />
      )}
    </div>
  );
}

function ProcessorPayModal({
  orderNumber,
  method,
  data,
  onClose,
  onPaid,
}: {
  orderNumber: string;
  method: PayMethod;
  data: InitiateResponse;
  onClose: () => void;
  onPaid?: () => void;
}) {
  const [paid, setPaid] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const frameName = method === 'payfast' ? 'gg-onsite-frame' : 'gg-ozow-frame';

  // PayFast Onsite: submit the signed submission into the in-app frame once.
  useEffect(() => {
    if (method === 'payfast') formRef.current?.submit();
  }, [method]);

  // Server-truth polling — the frames can't and may never declare success.
  useEffect(() => {
    if (paid) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/payments/seller/status?number=${encodeURIComponent(orderNumber)}`);
        if (!res.ok) return;
        const d = (await res.json()) as { paymentStatus?: string };
        if (!stopped && d.paymentStatus === 'paid') {
          setPaid(true);
          onPaid?.();
        }
      } catch {
        /* transient — keep polling */
      }
    };
    const id = setInterval(tick, 3000);
    void tick();
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [orderNumber, paid, onPaid]);

  const amountCents = data.amountCents ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" role="dialog" aria-modal="true" aria-label={`Pay for order ${orderNumber}`} data-testid="processor-modal">
      <div className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-xl border bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-semibold">
            {method === 'payfast' ? 'PayFast secure payment' : 'Ozow instant EFT'} — {formatMoney(amountCents)}
          </p>
          <Button type="button" variant="ghost" size="icon" aria-label="Close payment window" onClick={onClose}>
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        {paid ? (
          <div className="p-6 text-center" role="status">
            <BadgeCheck className="mx-auto h-10 w-10 text-primary" aria-hidden />
            <p className="mt-2 text-sm font-semibold">Payment received — order confirmed</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatMoney(amountCents)} for {orderNumber}. The seller has been notified automatically.
            </p>
            <Button type="button" className="mt-4 w-full" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <>
            <div className="relative min-h-[380px] flex-1 bg-white">
              {method === 'ozow' && data.paymentUrl ? (
                <iframe
                  name={frameName}
                  title="Ozow secure bank payment"
                  src={data.paymentUrl}
                  className="absolute inset-0 h-full w-full border-0"
                  data-testid="ozow-frame"
                />
              ) : (
                <iframe
                  name={frameName}
                  title="PayFast secure payment"
                  className="absolute inset-0 h-full w-full border-0"
                  data-testid="payfast-frame"
                />
              )}
            </div>
            <div className="border-t px-4 py-2.5">
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                Waiting for the payment to complete — this page updates automatically. You can close it and pay later from Orders.
              </p>
            </div>
          </>
        )}
      </div>

      {/* Hidden signed form — posted into the PayFast Onsite lightbox frame.
          Contains public form fields + the server-generated signature only. */}
      {method === 'payfast' && data.processUrl && data.submission && (
        <form
          ref={formRef}
          action={data.processUrl}
          method="post"
          target={frameName}
          className="hidden"
          aria-hidden="true"
        >
          {data.submission.map((f) => (
            <input key={f.name} type="hidden" name={f.name} value={f.value} readOnly />
          ))}
        </form>
      )}
    </div>
  );
}
