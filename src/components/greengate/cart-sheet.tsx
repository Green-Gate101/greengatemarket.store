'use client';

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ShoppingCart, Trash2, Lock } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { formatMoney, type CartLineDto, type ShippingOption } from '@/lib/types';
import { navigate } from './header';
import { useGuestCart } from './guest-cart';

export function CartSheet({ open, onOpenChange, trigger }: { open: boolean; onOpenChange: (o: boolean) => void; trigger?: React.ReactNode }) {
  const { data: session, status } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const serverCart = useQuery<{ lines: CartLineDto[] }>({
    queryKey: ['cart', 'server'],
    queryFn: async () => (await fetch('/api/cart')).json(),
    enabled: Boolean(session) && open,
  });

  const guestLines = useGuestCart((s) => s.lines);
  const lines: CartLineDto[] | null = session ? serverCart.data?.lines ?? null : null;
  const guestAsLines: CartLineDto[] | null = !session
    ? guestLines.map((l, i) => ({
        id: `guest-${i}`, productId: l.productId, variantId: l.variantId, quantity: l.quantity,
        name: l.name, image: l.image, unitPriceCents: l.unitPriceCents, stock: 99, slug: l.slug,
        store: { id: '', slug: '', name: l.storeName, location: '' },
      }))
    : null;
  const visibleLines = lines ?? guestAsLines ?? [];

  const subtotal = visibleLines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  const byStore = (() => {
    const map = new Map<string, CartLineDto[]>();
    for (const line of visibleLines) {
      const arr = map.get(line.store.name) ?? [];
      arr.push(line);
      map.set(line.store.name, arr);
    }
    return [...map.entries()];
  })();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent className="flex w-full flex-col p-0 sm:max-w-md">
        <SheetHeader className="border-b p-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ShoppingCart className="h-4 w-4" /> Your cart
          </SheetTitle>
          <SheetDescription className="text-xs">
            {byStore.length > 1 ? `${byStore.length} stores · ` : ''}{visibleLines.length} item{visibleLines.length === 1 ? '' : 's'}
          </SheetDescription>
        </SheetHeader>

        {status === 'loading' ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : visibleLines.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <ShoppingCart className="h-8 w-8 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">Your cart is empty</p>
            <p className="text-xs text-muted-foreground">Browse the marketplace and add items to check out.</p>
            <Button onClick={() => { onOpenChange(false); navigate({ name: 'store' }); }}>Start shopping</Button>
          </div>
        ) : (
          <>
            <ScrollArea className="flex-1 px-4">
              <div className="divide-y">
                {byStore.map(([storeName, storeLines]) => (
                  <div key={storeName} className="py-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{storeName}</p>
                    {storeLines.map((line) => (
                      <CartLine
                        key={line.id}
                        line={line}
                        signedIn={Boolean(session)}
                        onChanged={() => {
                          queryClient.invalidateQueries({ queryKey: ['cart'] });
                        }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </ScrollArea>

            <div className="border-t p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="font-bold">{formatMoney(subtotal)}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">Delivery is quoted at checkout. Totals are recalculated securely on the server.</p>
              <Button
                className="mt-3 w-full"
                size="lg"
                onClick={() => { onOpenChange(false); navigate({ name: 'account' }); }}
              >
                {session ? 'Checkout' : 'Sign in to checkout'}
                <Lock className="h-3.5 w-3.5" />
              </Button>
              <p className="mt-2 text-center text-[11px] text-muted-foreground">
                Bank transfer (EFT) — orders are confirmed after payment clears.
              </p>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function CartLine({ line, signedIn, onChanged }: { line: CartLineDto; signedIn: boolean; onChanged: () => void }) {
  const { toast } = useToast();

  const setQty = useMutation({
    mutationFn: async (quantity: number) => {
      if (signedIn) {
        const res = await fetch('/api/cart', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId: line.id, quantity }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? 'Could not update');
      } else {
        useGuestCart.getState().setQuantity(line.productId, line.variantId, quantity);
      }
    },
    onSuccess: onChanged,
    onError: (e: Error) => toast({ title: 'Cart', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="flex gap-3 py-2">
      <button className="h-16 w-16 shrink-0 overflow-hidden rounded-md border bg-white dark:bg-muted" onClick={() => navigate({ name: 'product', slug: line.slug })}>
        {line.image ? (
           
          <img src={line.image} alt={line.name} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">No image</div>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{line.name}</p>
        <p className="text-xs text-muted-foreground">{formatMoney(line.unitPriceCents)}</p>
        <div className="mt-1 flex items-center gap-2">
          <div className="flex items-center rounded-md border">
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Decrease" onClick={() => setQty.mutate(line.quantity - 1)}>−</Button>
            <span className="w-6 text-center text-xs">{line.quantity}</span>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Increase" disabled={line.quantity >= line.stock} onClick={() => setQty.mutate(line.quantity + 1)}>+</Button>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            aria-label="Remove item"
            onClick={() => setQty.mutate(0)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          <span className="ml-auto text-sm font-semibold">{formatMoney(line.unitPriceCents * line.quantity)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Full-page checkout used inside the account area (authenticated users only).
 * Server recomputes all totals; this form never sends prices.
 */
export function CheckoutPanel() {
  const { data: session } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const cart = useQuery<{ lines: CartLineDto[] }>({
    queryKey: ['cart', 'server'],
    queryFn: async () => (await fetch('/api/cart')).json(),
    enabled: Boolean(session),
  });

  const [buyerName, setBuyerName] = useState(session?.user?.name ?? '');
  const [buyerEmail, setBuyerEmail] = useState('');
  const [buyerPhone, setBuyerPhone] = useState('');
  const [address, setAddress] = useState('');
  const [shippingCode, setShippingCode] = useState('standard');
  const [placed, setPlaced] = useState<{ number: string; totalCents: number }[] | null>(null);

  const lines = cart.data?.lines ?? [];
  const subtotal = lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  const sellerLocation = lines[0]?.store.location ?? '';

  const shipping = useQuery<{ options: ShippingOption[] }>({
    queryKey: ['shipping', sellerLocation, address],
    queryFn: async () => {
      const res = await fetch('/api/shipping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sellerLocation, address, weightGrams: 1000 }),
      });
      if (!res.ok) throw new Error('Could not quote delivery');
      return res.json();
    },
    enabled: Boolean(session) && address.trim().length >= 5,
  });

  const shippingCents = shipping.data?.options.find((o) => o.code === shippingCode)?.priceCents
    ?? shipping.data?.options[0]?.priceCents ?? 0;

  const placeOrder = useMutation({
    mutationFn: async () => {
      const idempotencyKey = crypto.randomUUID();
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buyerName, buyerEmail, buyerPhone, address, shippingCode, idempotencyKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Checkout failed');
      return data as { orders: { number: string; totalCents: number }[] };
    },
    onSuccess: (data) => {
      setPlaced(data.orders);
      queryClient.invalidateQueries({ queryKey: ['cart'] });
      toast({ title: 'Order placed', description: 'Check your email for payment instructions.' });
    },
    onError: (e: Error) => toast({ title: 'Checkout', description: e.message, variant: 'destructive' }),
  });

  if (placed) {
    return (
      <div className="rounded-lg border bg-card p-6">
        <h2 className="text-lg font-bold">Order placed — thank you!</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Complete the bank transfer using the reference below. The seller confirms receipt and your order status updates in real time.
        </p>
        <ul className="mt-4 space-y-2">
          {placed.map((o) => (
            <li key={o.number} className="flex items-center justify-between rounded-md border bg-secondary px-4 py-3 text-sm">
              <span className="font-mono font-bold text-primary">{o.number}</span>
              <span className="font-semibold">{formatMoney(o.totalCents)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex gap-2">
          <Button onClick={() => navigate({ name: 'orders' })}>View my orders</Button>
          <Button variant="outline" onClick={() => navigate({ name: 'store' })}>Keep shopping</Button>
        </div>
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-10 text-center">
        <p className="text-sm font-medium">Your cart is empty</p>
        {cart.isError && (
          <p className="mt-2 text-xs text-destructive">Could not load your cart: {(cart.error as Error | null)?.message ?? 'unknown error'}. </p>
        )}
        <Button className="mt-3" variant="outline" onClick={() => navigate({ name: 'store' })}>Browse products</Button>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
      <form
        className="space-y-4 rounded-lg border bg-card p-6"
        onSubmit={(e) => {
          e.preventDefault();
          placeOrder.mutate();
        }}
      >
        <h2 className="text-lg font-bold">Delivery details</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="co-name">Recipient name</Label>
            <Input id="co-name" value={buyerName} onChange={(e) => setBuyerName(e.target.value)} required minLength={2} />
          </div>
          <div>
            <Label htmlFor="co-email">Email for the receipt</Label>
            <Input id="co-email" type="email" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="co-phone">Contact number</Label>
            <Input id="co-phone" type="tel" value={buyerPhone} onChange={(e) => setBuyerPhone(e.target.value)} required />
          </div>
        </div>
        <div>
          <Label htmlFor="co-address">Full delivery address</Label>
          <textarea
            id="co-address"
            className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Street address, suburb, city, province, postal code"
            required
            minLength={10}
          />
        </div>

        <div>
          <Label className="text-sm">Delivery option</Label>
          {address.trim().length < 5 ? (
            <p className="mt-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">Enter the delivery address to see courier options.</p>
          ) : shipping.isLoading ? (
            <p className="mt-2 text-xs text-muted-foreground">Fetching courier rates…</p>
          ) : (
            <RadioGroup className="mt-2 space-y-2" value={shippingCode} onValueChange={setShippingCode}>
              {(shipping.data?.options ?? []).map((opt) => (
                <Label key={opt.code} htmlFor={`ship-${opt.code}`} className="flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm hover:bg-accent/40">
                  <RadioGroupItem id={`ship-${opt.code}`} value={opt.code} />
                  <span className="flex-1">
                    <span className="font-medium">{opt.label}</span>
                    <span className="block text-xs text-muted-foreground">{opt.eta}</span>
                  </span>
                  <span className="font-semibold">{formatMoney(opt.priceCents)}</span>
                </Label>
              ))}
            </RadioGroup>
          )}
        </div>

        <Button type="submit" size="lg" className="w-full" disabled={placeOrder.isPending}>
          {placeOrder.isPending ? 'Placing order…' : `Place order — ${formatMoney(subtotal + shippingCents)}`}
        </Button>
        <p className="text-center text-[11px] text-muted-foreground">
          Payment is by bank transfer (EFT). We never ask for card details and never mark orders paid without confirmation.
        </p>
      </form>

      <aside className="h-fit rounded-lg border bg-card p-6" aria-label="Order summary">
        <h2 className="text-sm font-bold">Order summary</h2>
        <div className="mt-3 space-y-2 text-sm">
          {lines.map((l) => (
            <div key={l.id} className="flex justify-between gap-2">
              <span className="min-w-0 truncate text-muted-foreground">{l.quantity} × {l.name}</span>
              <span>{formatMoney(l.unitPriceCents * l.quantity)}</span>
            </div>
          ))}
        </div>
        <Separator className="my-3" />
        <div className="flex justify-between text-sm"><span className="text-muted-foreground">Subtotal</span><span>{formatMoney(subtotal)}</span></div>
        <div className="flex justify-between text-sm"><span className="text-muted-foreground">Delivery</span><span>{shippingCents ? formatMoney(shippingCents) : '—'}</span></div>
        <div className="mt-2 flex justify-between border-t pt-2 text-base font-bold"><span>Total</span><span>{formatMoney(subtotal + shippingCents)}</span></div>
      </aside>
    </div>
  );
}
