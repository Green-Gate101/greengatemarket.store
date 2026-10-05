'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ProductImage } from './product-image';
import { useCart } from '@/lib/cart-store';
import { formatZAR } from '@/lib/format';
import type { ShippingOption } from '@/lib/types';
import {
  BadgeCheck,
  Loader2,
  MailCheck,
  Minus,
  Plus,
  ShoppingBag,
  Trash2,
  Truck,
} from 'lucide-react';

type Stage = 'cart' | 'checkout' | 'done';

export function CartSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const lines = useCart((s) => s.lines);
  const setQuantity = useCart((s) => s.setQuantity);
  const remove = useCart((s) => s.remove);
  const clear = useCart((s) => s.clear);

  const [stage, setStage] = useState<Stage>('cart');
  const [rates, setRates] = useState<ShippingOption[] | null>(null);
  const [rateCode, setRateCode] = useState('standard');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderRefs, setOrderRefs] = useState<string[]>([]);
  const [buyer, setBuyer] = useState({ buyerName: '', buyerEmail: '', buyerPhone: '', address: '' });

  const subtotal = lines.reduce((s, l) => s + l.product.price * l.quantity, 0);
  const rate = rates?.find((r) => r.code === rateCode) ?? null;
  const sellerCount = useMemo(() => new Set(lines.map((l) => l.product.sellerId)).size, [lines]);
  const shippingTotal = rate ? rate.price * sellerCount : 0;
  const total = subtotal + shippingTotal;

  useEffect(() => {
    if (open && stage === 'checkout' && !rates) {
      setRates(null);
      fetch('/api/shipping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buyerAddress: buyer.address || 'South Africa',
          sellerLocation: lines[0]?.product.seller?.location ?? 'South Africa',
          weightKg: Math.max(1, lines.reduce((s, l) => s + l.quantity, 0) * 0.8),
        }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          setRates(d?.rates ?? []);
          if (d?.rates?.length) setRateCode(d.rates[Math.min(1, d.rates.length - 1)].code);
        })
        .catch(() => setRates([]));
    }
    if (!open && stage === 'done') {
      setStage('cart');
      setOrderRefs([]);
      setBuyer({ buyerName: '', buyerEmail: '', buyerPhone: '', address: '' });
    }
  }, [open, stage, rates, buyer.address, lines]);

  const submitOrder = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...buyer,
          shippingMethod: rateCode,
          items: lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Checkout failed');
      const orders: Array<{ id: string }> = data.orders ?? [];
      setOrderRefs(orders.map((o) => o.id.slice(-8).toUpperCase()));
      clear();
      setStage('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkout failed');
    } finally {
      setSubmitting(false);
    }
  };

  const canCheckout =
    buyer.buyerName.trim().length >= 2 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer.buyerEmail) &&
    buyer.buyerPhone.replace(/\D/g, '').length >= 9 &&
    buyer.address.trim().length >= 10 &&
    !!rate;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md" aria-describedby={undefined}>
        <SheetHeader className="pb-2">
          <SheetTitle className="flex items-center gap-2">
            <ShoppingBag className="h-5 w-5" aria-hidden />
            {stage === 'done' ? 'Order confirmed' : stage === 'checkout' ? 'Checkout' : 'Your cart'}
          </SheetTitle>
          <SheetDescription>
            {stage === 'cart' && `${lines.length} line${lines.length === 1 ? '' : 's'} from ${sellerCount} store${sellerCount === 1 ? '' : 's'}`}
            {stage === 'checkout' && 'Delivery details and shipping method'}
            {stage === 'done' && 'A receipt has been emailed to you'}
          </SheetDescription>
        </SheetHeader>

        {stage === 'cart' && (
          <>
            {lines.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <ShoppingBag className="h-10 w-10 text-muted-foreground/40" aria-hidden />
                <p className="text-sm font-medium">Your cart is empty</p>
                <p className="max-w-[220px] text-xs text-muted-foreground">
                  Browse the marketplace and add products to get started.
                </p>
              </div>
            ) : (
              <>
                <ScrollArea className="-mx-4 min-h-0 flex-1 px-4">
                  <ul className="space-y-4 pb-4">
                    {lines.map((l) => (
                      <li key={l.product.id} className="flex gap-3">
                        <div className="h-16 w-16 shrink-0 rounded-md border bg-white p-1">
                          <ProductImage src={l.product.imageData} alt={l.product.name} className="h-full w-full object-contain" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{l.product.name}</p>
                          <p className="text-xs text-muted-foreground">{l.product.seller?.storeName}</p>
                          <div className="mt-1.5 flex items-center justify-between">
                            <div className="flex items-center rounded-md border" role="group" aria-label={`Quantity for ${l.product.name}`}>
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setQuantity(l.product.id, l.quantity - 1)} aria-label="Decrease quantity">
                                <Minus className="h-3 w-3" aria-hidden />
                              </Button>
                              <span className="w-6 text-center text-xs font-medium tabular-nums">{l.quantity}</span>
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setQuantity(l.product.id, l.quantity + 1)} aria-label="Increase quantity">
                                <Plus className="h-3 w-3" aria-hidden />
                              </Button>
                            </div>
                            <p className="text-sm font-semibold tabular-nums">{formatZAR(l.product.price * l.quantity)}</p>
                          </div>
                        </div>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => remove(l.product.id)} aria-label={`Remove ${l.product.name} from cart`}>
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </Button>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
                <div className="border-t pt-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span className="font-semibold tabular-nums">{formatZAR(subtotal)}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">Shipping is calculated at checkout.</p>
                  <Button
                    className="mt-3 w-full"
                    size="lg"
                    onClick={() => setStage('checkout')}
                    disabled={lines.length === 0}
                  >
                    Continue to checkout
                  </Button>
                </div>
              </>
            )}
          </>
        )}

        {stage === 'checkout' && (
          <>
            <ScrollArea className="-mx-4 min-h-0 flex-1 px-4">
              <div className="space-y-4 pb-4">
                <div className="grid gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="buyer-name">Full name</Label>
                    <Input id="buyer-name" value={buyer.buyerName} onChange={(e) => setBuyer((b) => ({ ...b, buyerName: e.target.value }))} placeholder="Lerato Khumalo" autoComplete="name" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="buyer-email">Email for your receipt</Label>
                    <Input id="buyer-email" type="email" value={buyer.buyerEmail} onChange={(e) => setBuyer((b) => ({ ...b, buyerEmail: e.target.value }))} placeholder="you@example.co.za" autoComplete="email" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="buyer-phone">Phone for the courier</Label>
                    <Input id="buyer-phone" type="tel" value={buyer.buyerPhone} onChange={(e) => setBuyer((b) => ({ ...b, buyerPhone: e.target.value }))} placeholder="+27 82 000 0000" autoComplete="tel" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="buyer-address">Delivery address</Label>
                    <Textarea id="buyer-address" value={buyer.address} onChange={(e) => setBuyer((b) => ({ ...b, address: e.target.value }))} placeholder="Street, suburb, city and postal code" rows={2} />
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label className="flex items-center gap-1.5">
                    <Truck className="h-4 w-4" aria-hidden /> Shipping method
                    {sellerCount > 1 && <span className="font-normal text-muted-foreground">· charged per store ({sellerCount})</span>}
                  </Label>
                  {rates === null ? (
                    <div className="flex items-center gap-2 rounded-md border p-3 text-sm text-muted-foreground" role="status">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Fetching courier rates…
                    </div>
                  ) : (
                    <RadioGroup value={rateCode} onValueChange={setRateCode} className="gap-2">
                      {rates.map((r) => (
                        <Label
                          key={r.code}
                          htmlFor={`rate-${r.code}`}
                          className="flex cursor-pointer items-center justify-between rounded-md border p-3 [&:has([data-state=checked])]:border-primary [&:has([data-state=checked])]:bg-primary/5"
                        >
                          <span className="flex items-center gap-2.5">
                            <RadioGroupItem id={`rate-${r.code}`} value={r.code} />
                            <span>
                              <span className="block text-sm font-medium">{r.label}</span>
                              <span className="block text-xs text-muted-foreground">{r.eta} · {r.provider === 'thecourierguy' ? 'The Courier Guy' : 'Soko courier network'}</span>
                            </span>
                          </span>
                          <span className="text-sm font-semibold tabular-nums">{formatZAR(r.price * sellerCount)}</span>
                        </Label>
                      ))}
                    </RadioGroup>
                  )}
                </div>

                <Separator />
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Subtotal</dt>
                    <dd className="tabular-nums">{formatZAR(subtotal)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Shipping ({sellerCount} store{sellerCount === 1 ? '' : 's'})</dt>
                    <dd className="tabular-nums">{formatZAR(shippingTotal)}</dd>
                  </div>
                  <div className="flex justify-between border-t pt-1.5 text-base font-semibold">
                    <dt>Total</dt>
                    <dd className="tabular-nums">{formatZAR(total)}</dd>
                  </div>
                </dl>
                {error && (
                  <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
                    {error}
                  </p>
                )}
              </div>
            </ScrollArea>
            <div className="border-t pt-4">
              <Button className="w-full" size="lg" onClick={submitOrder} disabled={!canCheckout || submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Placing order…
                  </>
                ) : (
                  `Pay ${formatZAR(total)}`
                )}
              </Button>
              <Button variant="ghost" className="mt-2 w-full" onClick={() => setStage('cart')} disabled={submitting}>
                Back to cart
              </Button>
            </div>
          </>
        )}

        {stage === 'done' && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
              <BadgeCheck className="h-7 w-7" aria-hidden />
            </span>
            <p className="text-base font-semibold">Thank you for your order!</p>
            <div className="rounded-md border bg-muted/40 px-4 py-3 text-sm">
              <p className="text-muted-foreground">Order reference{orderRefs.length > 1 ? 's' : ''}</p>
              <p className="mt-0.5 font-mono font-medium">{orderRefs.join(' · ')}</p>
            </div>
            <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <MailCheck className="h-3.5 w-3.5 text-primary" aria-hidden />
              Your receipt and courier updates are on their way by email.
            </p>
            <Button className="mt-2" onClick={() => onOpenChange(false)}>
              Continue shopping
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
