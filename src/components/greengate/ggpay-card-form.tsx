'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, CreditCard, Lock, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { formatMoney } from '@/lib/types';
import { CardSchemeLogos } from './payment-logos';

/**
 * GGPay in-app card payment form — the "Pay now" step of the marketplace's
 * own payment system (Amazon/Takealot-style). The buyer never leaves the app:
 * card details are validated here, charged server-side, and the order
 * confirms automatically on approval. Full card numbers are sent only to the
 * marketplace's charge API over HTTPS and are never stored (brand + last 4
 * only land in the database).
 */

interface PayResponse {
  ok?: boolean;
  alreadyPaid?: boolean;
  declined?: boolean;
  error?: string;
  payment?: { reference: string; brand: string; last4: string };
  payout?: { reference: string; netCents: number } | null;
}

function brandLabel(brand: string): string {
  if (brand === 'visa') return 'Visa';
  if (brand === 'mastercard') return 'Mastercard';
  if (brand === 'amex') return 'Amex';
  return 'Card';
}

export function GgPayCardForm({ orderNumber, totalCents, onPaid }: { orderNumber: string; totalCents: number; onPaid?: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [cardNumber, setCardNumber] = useState('');
  const [cardName, setCardName] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvv, setCvv] = useState('');
  const [decline, setDecline] = useState<string | null>(null);

  const digits = cardNumber.replace(/\D/g, '');
  const brand = useMemo(() => {
    if (/^4/.test(digits)) return 'visa';
    if (/^(5[1-5]|2[2-7])/.test(digits)) return 'mastercard';
    if (/^3[47]/.test(digits)) return 'amex';
    return null;
  }, [digits]);

  const pay = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/payments/ggpay/charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber, cardNumber, cardName, expiry, cvv }),
      });
      const data = (await res.json()) as PayResponse;
      if (!res.ok) throw new Error(data.error ?? 'Payment failed');
      return data;
    },
    onSuccess: (data) => {
      if (data.alreadyPaid) {
        onPaid?.();
        return;
      }
      toast({ title: 'Payment successful', description: `Order ${orderNumber} is confirmed — ref ${data.payment?.reference ?? ''}` });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['order'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      onPaid?.();
    },
    onError: (e: Error) => {
      setDecline(e.message);
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });

  // --- input masks ---------------------------------------------------------
  const onCardChange = (v: string) => {
    const d = v.replace(/\D/g, '').slice(0, 19);
    setCardNumber(d.replace(/(.{4})/g, '$1 ').trim());
    setDecline(null);
  };
  const onExpiryChange = (v: string) => {
    const d = v.replace(/\D/g, '').slice(0, 4);
    setExpiry(d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d);
    setDecline(null);
  };

  if (pay.isSuccess) {
    return (
      <div className="rounded-lg border border-primary/30 bg-primary/5 p-4" role="status">
        <p className="flex items-center gap-2 text-sm font-semibold text-primary">
          <BadgeCheck className="h-4 w-4" aria-hidden /> Paid {formatMoney(totalCents)} — order confirmed
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Ref {pay.data?.payment?.reference ?? ''} · {brandLabel(pay.data?.payment?.brand ?? 'card')} ·· {pay.data?.payment?.last4 ?? ''}
          {pay.data?.payout ? ` · seller payout ${pay.data.payout.reference} queued automatically` : ''}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-4" data-testid="ggpay-form">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Lock className="h-4 w-4 text-primary" aria-hidden /> Pay {formatMoney(totalCents)} by card — in-app checkout
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">Visa, Mastercard and American Express. The order confirms instantly — like Amazon.</p>
      <div className="mt-3 grid gap-3">
        <div>
          <Label htmlFor={`ggpay-num-${orderNumber}`}>Card number</Label>
          <div className="relative">
            <Input
              id={`ggpay-num-${orderNumber}`}
              inputMode="numeric"
              autoComplete="cc-number"
              placeholder="4242 4242 4242 4242"
              value={cardNumber}
              onChange={(e) => onCardChange(e.target.value)}
              className="pr-16"
              required
            />
            {brand && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{brandLabel(brand)}</span>
            )}
          </div>
        </div>
        <div>
          <Label htmlFor={`ggpay-name-${orderNumber}`}>Cardholder name</Label>
          <Input
            id={`ggpay-name-${orderNumber}`}
            autoComplete="cc-name"
            placeholder="Name printed on the card"
            value={cardName}
            onChange={(e) => { setCardName(e.target.value); setDecline(null); }}
            required
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor={`ggpay-exp-${orderNumber}`}>Expiry (MM/YY)</Label>
            <Input
              id={`ggpay-exp-${orderNumber}`}
              inputMode="numeric"
              autoComplete="cc-exp"
              placeholder="12/28"
              value={expiry}
              onChange={(e) => onExpiryChange(e.target.value)}
              required
            />
          </div>
          <div>
            <Label htmlFor={`ggpay-cvv-${orderNumber}`}>CVV</Label>
            <Input
              id={`ggpay-cvv-${orderNumber}`}
              inputMode="numeric"
              autoComplete="cc-csc"
              placeholder={brand === 'amex' ? '4 digits' : '3 digits'}
              value={cvv}
              onChange={(e) => { setCvv(e.target.value.replace(/\D/g, '').slice(0, 4)); setDecline(null); }}
              required
            />
          </div>
        </div>
      </div>
      {decline && (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" role="alert">
          {decline} The order stays unpaid — try again or use another payment method.
        </p>
      )}
      <Button type="button" className="mt-3 w-full" disabled={pay.isPending || digits.length < 12 || !cardName.trim() || expiry.length < 4 || cvv.length < 3} onClick={() => pay.mutate()}>
        {pay.isPending ? (
          <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> Processing payment…</>
        ) : (
          <><CreditCard className="mr-1.5 h-4 w-4" aria-hidden /> Pay {formatMoney(totalCents)} now</>
        )}
      </Button>
      <p className="mt-2 flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
        <ShieldCheck className="h-3 w-3" aria-hidden /> Encrypted in transit · card numbers are never stored · payment verified server-side
      </p>
      <p className="mt-1.5 flex items-center justify-center gap-2" aria-label="We accept Visa and Mastercard">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">We accept</span>
        <CardSchemeLogos size="sm" />
      </p>
      <p className="mt-1 text-center text-[10px] text-muted-foreground">
        Test cards only while in-app card payments run in test mode: 4242 4242 4242 4242 approves · a card ending 0002 declines · ending 9995 has insufficient funds. Real cards cannot be charged in test mode — use the seller&apos;s Yoco / PayFast / Ozow options or bank transfer.
      </p>
    </div>
  );
}
