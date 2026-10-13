'use client';

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';
import { Crosshair, Loader2 } from 'lucide-react';
import { ShoppingCart, Trash2, Lock } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { formatMoney, type CartLineDto, type ShippingOption } from '@/lib/types';
import { navigate } from './header';
import { useGuestCart } from './guest-cart';
import { captureGpsFix, reverseGeocode, formatAddressLine, parseAddressLine, accuracyLabel, type GeoParts } from '@/lib/geo';
import { LocationAutocomplete } from './location-autocomplete';
import type { AddressDto } from './addresses-panel';

/** The exact delivery pin riding with the order to The Courier Guy. */
interface DeliveryPin {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  source: 'gps' | 'saved' | 'search';
}

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
  const [saveLocation, setSaveLocation] = useState(false);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [pickedId, setPickedId] = useState<string>('');
  const [gpsParts, setGpsParts] = useState<GeoParts | null>(null);
  const [pin, setPin] = useState<DeliveryPin | null>(null);
  const [pinNote, setPinNote] = useState<string | null>(null);
  // Coordinates from an address-search pick (Google-Maps-style suggestion).
  const [searchPick, setSearchPick] = useState<{ line: string; latitude: number; longitude: number } | null>(null);

  // Saved "always deliver here" locations — pre-fill the default one.
  const savedLocations = useQuery<{ addresses: AddressDto[] }>({
    queryKey: ['addresses'],
    queryFn: async () => (await fetch('/api/addresses')).json(),
    enabled: Boolean(session),
  });
  const savedAddresses = savedLocations.data?.addresses ?? [];

  useEffect(() => {
    if (!address && savedAddresses.length > 0) {
      const def = savedAddresses.find((a) => a.isDefault) ?? savedAddresses[0];
      setAddress(formatAddressLine(def));
      setPickedId(def.id);
      if (def.phone && !buyerPhone) setBuyerPhone(def.phone);
      // The saved default carries its exact GPS pin — every order delivers
      // there with the same precise coordinates automatically.
      if (def.latitude !== null && def.longitude !== null) {
        setPin({ latitude: def.latitude, longitude: def.longitude, accuracyMeters: def.accuracyMeters ?? null, source: 'saved' });
        setPinNote(`Delivering to your default location${def.accuracyMeters != null ? ` (${accuracyLabel(def.accuracyMeters)})` : ''} — the courier gets this exact pin.`);
      }
    }
  }, [savedLocations.isSuccess]);

  const pickSaved = (id: string) => {
    const a = savedAddresses.find((x) => x.id === id);
    if (!a) return;
    setPickedId(a.id);
    setAddress(formatAddressLine(a));
    if (a.phone) setBuyerPhone(a.phone);
    if (a.latitude !== null && a.longitude !== null) {
      setPin({ latitude: a.latitude, longitude: a.longitude, accuracyMeters: a.accuracyMeters ?? null, source: 'saved' });
      setPinNote(`Delivering to “${a.label}”${a.accuracyMeters != null ? ` (${accuracyLabel(a.accuracyMeters)})` : ''} — the courier gets this exact pin.`);
    } else {
      setPin(null);
      setPinNote(null);
    }
  };

  const useGpsHere = async () => {
    setGpsBusy(true);
    try {
      // Refined capture: keeps listening after the first (often coarse) fix
      // and returns the most accurate lock, so the courier pin is tight.
      const captured = await captureGpsFix();
      const parts = await reverseGeocode(captured);
      if (parts) {
        setAddress(formatAddressLine(parts));
        setGpsParts(parts);
        toast({ title: 'Location captured', description: 'Check the address below — adjust if needed.' });
      } else {
        const line = `GPS ${captured.latitude.toFixed(5)}, ${captured.longitude.toFixed(5)}`;
        setAddress(line);
        setGpsParts(null);
        toast({ title: 'Location captured', description: 'We pinned your exact position — add street details for the courier.' });
      }
      setPin({ latitude: captured.latitude, longitude: captured.longitude, accuracyMeters: captured.accuracyMeters, source: 'gps' });
      setPinNote(`Courier pin: ${captured.latitude.toFixed(5)}, ${captured.longitude.toFixed(5)}${captured.accuracyMeters != null ? ` — ${accuracyLabel(captured.accuracyMeters)}` : ''}`);
      setPickedId('');
    } catch (e) {
      toast({ title: 'Location', description: e instanceof Error ? e.message : 'Could not detect your location.', variant: 'destructive' });
    } finally {
      setGpsBusy(false);
    }
  };

  const saveLocationMutation = useMutation({
    mutationFn: async () => {
      // Prefer the structured GPS parts — but only when the user has not
      // edited the line afterwards; otherwise parse what is typed now.
      const parts = gpsParts && formatAddressLine(gpsParts) === address.trim() ? gpsParts : parseAddressLine(address);
      // A search suggestion that is still untouched carries its exact pin.
      const picked = searchPick && searchPick.line === address.trim() ? searchPick : null;
      const res = await fetch('/api/addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Home',
          recipientName: buyerName,
          phone: buyerPhone,
          street: parts.street || address,
          city: parts.city,
          province: parts.province,
          postalCode: parts.postalCode,
          latitude: picked?.latitude,
          longitude: picked?.longitude,
          locationSource: gpsParts && formatAddressLine(gpsParts) === address.trim() ? 'gps' : picked ? 'search' : 'manual',
          isDefault: true, // the checkbox promises "always deliver here"
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not save');
      return data;
    },
    onSuccess: () => {
      toast({ title: 'Location saved', description: 'Future orders will deliver here by default.' });
      savedLocations.refetch();
    },
    onError: (e: Error) => {
      setSaveLocation(false);
      toast({ title: 'Locations', description: e.message, variant: 'destructive' });
    },
  });

  const lines = cart.data?.lines ?? [];
  const subtotal = lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  const sellerLocation = lines[0]?.store.location ?? '';

  const shipping = useQuery<{ options: ShippingOption[] }>({
    queryKey: ['shipping', sellerLocation, address, pin?.latitude, pin?.longitude],
    queryFn: async () => {
      const res = await fetch('/api/shipping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sellerLocation,
          address,
          weightGrams: 1000,
          latitude: pin?.latitude,
          longitude: pin?.longitude,
        }),
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
      // crypto.randomUUID needs a modern secure-context browser; older
      // in-app WebViews lack it. Fall back to a random key — same purpose.
      const idempotencyKey = globalThis.crypto?.randomUUID?.()
        ?? `gg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buyerName, buyerEmail, buyerPhone, address, shippingCode, idempotencyKey,
          // The exact pin rides with EVERY order — The Courier Guy receives it
          // for pricing and the seller gets the map link. When the buyer types
          // their saved default address instead, the server attaches that pin
          // automatically, so a pin is present on every order either way.
          latitude: pin?.latitude,
          longitude: pin?.longitude,
          accuracyMeters: pin?.accuracyMeters ?? undefined,
          pinSource: pin?.source,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Checkout failed');
      return data as { orders: { number: string; totalCents: number }[] };
    },
    onSuccess: (data) => {
      setPlaced(data.orders);
      queryClient.invalidateQueries({ queryKey: ['cart'] });
      // The server just created order notifications — refresh the bell's badge.
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="co-address">Full delivery address</Label>
            <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={useGpsHere} disabled={gpsBusy}>
              {gpsBusy ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" aria-hidden /> : <Crosshair className="mr-1.5 h-3 w-3" aria-hidden />}
              {gpsBusy ? 'Finding you…' : 'Use my current location'}
            </Button>
          </div>
          {savedAddresses.length > 0 && (
            <div className="mt-2">
              <Label className="text-xs text-muted-foreground" htmlFor="co-saved">Saved locations</Label>
              <select
                id="co-saved"
                className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none"
                value={pickedId}
                onChange={(e) => pickSaved(e.target.value)}
              >
                <option value="">Choose a saved location…</option>
                {savedAddresses.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.isDefault ? '★ ' : ''}{a.label} — {[a.street, a.city].filter(Boolean).join(', ')}
                  </option>
                ))}
              </select>
            </div>
          )}
          <LocationAutocomplete
            as="textarea"
            id="co-address"
            rows={4}
            value={address}
            onValueChange={(v) => {
              setAddress(v);
              // Manual edits release the saved-location pick AND the pin that
              // came with it — the server still re-attaches the default pin
              // automatically when the final text matches that location.
              setPickedId('');
              if (searchPick) setSearchPick(null);
              if (pin) {
                setPin(null);
                setPinNote(null);
              }
            }}
            onPick={(s) => {
              // Google-Maps-style pick: one line filled in, exact pin kept.
              setAddress(s.line);
              setPickedId('');
              setGpsParts(null);
              setSearchPick({ line: s.line, latitude: s.latitude, longitude: s.longitude });
              setPin({ latitude: s.latitude, longitude: s.longitude, accuracyMeters: null, source: 'search' });
              setPinNote(`Courier pin: ${s.latitude.toFixed(5)}, ${s.longitude.toFixed(5)} — from the address suggestion`);
            }}
            placeholder="Street address, suburb, city, province, postal code — start typing and pick a suggestion"
            required
            minLength={10}
            ariaLabel="Full delivery address with suggestions"
          />
          {!pickedId && address.trim().length >= 10 && buyerName.trim().length >= 2 && (
            <>
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs">
                <Checkbox checked={saveLocation} onCheckedChange={(v) => { setSaveLocation(v === true); if (v === true) saveLocationMutation.mutate(); }} id="co-save-loc" />
                <span>Always deliver here — save this as my default location</span>
              </label>
              {!saveLocation && !gpsParts && (
                <p className="mt-1 text-[11px] text-muted-foreground">Tip: use the format “street, suburb, city, province, postal code” so the location can be saved.</p>
              )}
            </>
          )}
          {pinNote && (
            <p className="mt-2 flex items-start gap-1.5 rounded-md border border-primary/30 bg-primary/5 p-2 text-[11px] text-foreground" role="status">
              <Crosshair className="mt-0.5 h-3 w-3 shrink-0 text-primary" aria-hidden />
              {pinNote}
            </p>
          )}
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
