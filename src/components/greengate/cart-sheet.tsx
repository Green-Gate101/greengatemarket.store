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
import { formatMoney, type CartLineDto, type EftDetailsDto, type ShippingOption } from '@/lib/types';
import { navigate } from './header';
import { GgPayCardForm } from './ggpay-card-form';
import { SellerPayButtons, payOrderNow } from './in-app-pay';
import { PayFastLogo, YocoLogo } from './payment-logos';
import { useGuestCart } from './guest-cart';
import { captureGpsFix, reverseGeocode, formatAddressLine, parseAddressLine, accuracyLabel, type GeoParts } from '@/lib/geo';
import { LocationAutocomplete } from './location-autocomplete';
import type { AddressDto } from './addresses-panel';
import { readJson, sizedImage } from '@/lib/utils';
import { PICKUP_INFO, type PickupKind } from '@/lib/pickup';
import { rememberReturnTo } from './return-route';
import { showRefundPolicy } from './legal-view';

/** The exact delivery pin riding with the order to The Courier Guy. */
interface DeliveryPin {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  source: 'gps' | 'saved' | 'search';
}

/**
 * Signature of the last "removed" list toasted by either cart surface (sheet
 * and checkout panel share one cart query). One module-level guard means a
 * dead row cleanup never toasts twice on the same data.
 */
let lastRemovedSig = '';

/** Toast the buyer once per distinct cleanup — items never vanish silently. */
function useRemovedItemsToast(data: { removed?: string[] } | undefined) {
  const { toast } = useToast();
  const removed = data?.removed ?? [];
  const sig = removed.join('|');
  useEffect(() => {
    if (removed.length === 0 || sig === lastRemovedSig) return;
    lastRemovedSig = sig;
    toast({
      title: 'Some items are no longer available',
      description: `${removed.join(', ')} ${removed.length > 1 ? 'were' : 'was'} removed from your cart.`,
    });
  }, [sig, removed.length, toast]);
}

export function CartSheet({ open, onOpenChange, trigger }: { open: boolean; onOpenChange: (o: boolean) => void; trigger?: React.ReactNode }) {
  const { data: session, status } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const serverCart = useQuery<{ lines: CartLineDto[]; removed?: string[] }>({
    queryKey: ['cart', 'server'],
    queryFn: async () => {
      const res = await fetch('/api/cart');
      if (!res.ok) throw new Error('Could not load your cart');
      return readJson(res);
    },
    enabled: Boolean(session) && open,
  });
  useRemovedItemsToast(serverCart.data);

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
                onClick={() => {
                  onOpenChange(false);
                  if (session) {
                    navigate({ name: 'account' });
                  } else {
                    // Signed out: sign in, then come straight back to checkout.
                    rememberReturnTo('#/account');
                    navigate({ name: 'signin' });
                  }
                }}
              >
                {session ? 'Checkout' : 'Sign in to checkout'}
                <Lock className="h-3.5 w-3.5" />
              </Button>
              <p className="mt-2 text-center text-[11px] text-muted-foreground">
                Pay securely by card or instant EFT on the seller's PayFast, Ozow or Yoco page — your order confirms automatically the moment payment is verified.
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
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not update');
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
           
          <img src={sizedImage(line.image, 160)} alt={line.name} className="h-full w-full object-cover" />
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

  const cart = useQuery<{ lines: CartLineDto[]; removed?: string[] }>({
    queryKey: ['cart', 'server'],
    queryFn: async () => {
      const res = await fetch('/api/cart');
      if (!res.ok) throw new Error('Could not load your cart');
      return readJson(res);
    },
    enabled: Boolean(session),
  });
  useRemovedItemsToast(cart.data);

  const [buyerName, setBuyerName] = useState(session?.user?.name ?? '');
  // Prefilled from the signed-in account: an empty required email here would
  // silently block "Place order" via HTML5 validation — the #1 kind of
  // checkout failure that shows up as "the button does nothing" on some
  // devices. The buyer can still edit it; the server also re-verifies.
  const [buyerEmail, setBuyerEmail] = useState(session?.user?.email ?? '');
  const [buyerPhone, setBuyerPhone] = useState('');
  const [address, setAddress] = useState('');
  const [shippingCode, setShippingCode] = useState('standard');
  const [placed, setPlaced] = useState<{ number: string; totalCents: number; paymentUrl?: string; paymentKind?: string; store?: { name?: string; payoutProvider?: string | null; payoutLink?: string | null; payoutNote?: string | null; payfastReady?: boolean; ozowReady?: boolean; yocoReady?: boolean; eft?: EftDetailsDto | null } }[] | null>(null);
  // Orders paid in-app via GGPay since the confirmation screen rendered.
  const [paidNums, setPaidNums] = useState<string[]>([]);
  const [payfastFlag, setPayfastFlag] = useState(false);
  // In-app card form only when the server says it can really take a payment.
  const [ggpayFlag, setGgpayFlag] = useState(false);
  const [saveLocation, setSaveLocation] = useState(false);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [pickedId, setPickedId] = useState<string>('');
  const [gpsParts, setGpsParts] = useState<GeoParts | null>(null);
  const [pin, setPin] = useState<DeliveryPin | null>(null);
  const [pinNote, setPinNote] = useState<string | null>(null);
  // Coordinates from an address-search pick (Google-Maps-style suggestion).
  const [searchPick, setSearchPick] = useState<{ line: string; latitude: number; longitude: number } | null>(null);
  // Door delivery, or collection at a PAXI point / Pudo locker (when every
  // seller in the cart offers it) — the pickup point is what the buyer types.
  const [deliveryMethod, setDeliveryMethod] = useState<'door' | PickupKind>('door');
  // True while the buyer is being taken straight to the secure payment page.
  const [payingNow, setPayingNow] = useState(false);
  const [pickupPoint, setPickupPoint] = useState('');
  // Discount code: previewed here, checked again and claimed at checkout.
  const [discountInput, setDiscountInput] = useState('');
  const [appliedDiscount, setAppliedDiscount] = useState<{ code: string; cartSig: string; discountCents: number; applies: { storeName: string; discountCents: number; label: string }[]; problems: { storeName: string; reason: string }[] } | null>(null);

  // Saved "always deliver here" locations — pre-fill the default one.
  const savedLocations = useQuery<{ addresses: AddressDto[] }>({
    queryKey: ['addresses'],
    queryFn: async () => readJson(await fetch('/api/addresses')),
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

  // If the session arrived AFTER first render (slow devices, cold cache),
  // fill the recipient name and receipt email once — an empty required
  // email field silently blocks submission via HTML5 validation.
  useEffect(() => {
    if (!session?.user) return;
    setBuyerName((v) => v || session.user?.name || '');
    setBuyerEmail((v) => v || session.user?.email || '');
  }, [session?.user]);

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
      const data = await readJson(res);
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
  const cartSig = lines.map((l) => `${l.productId}:${l.variantId ?? ''}:x${l.quantity}`).join('|');

  // Pickup points on offer: only when EVERY seller in the cart offers that
  // kind (each sends their own parcel there and charges their own price).
  const cartStores = [...new Map(lines.map((l) => [l.store.id, l.store])).values()];
  const pickupTotal = (kind: PickupKind): number | null =>
    cartStores.length > 0 && cartStores.every((st) => st.pickup?.[kind])
      ? cartStores.reduce((n, st) => n + (st.pickup?.[kind]?.priceCents ?? 0), 0)
      : null;
  const pickupOffers: Record<PickupKind, number | null> = { paxi: pickupTotal('paxi'), pudo: pickupTotal('pudo') };
  const pickupEta = (kind: PickupKind): string => {
    const etas = [...new Set(cartStores.map((st) => st.pickup?.[kind]?.eta).filter(Boolean))];
    return etas.length === 1 ? String(etas[0]) : 'delivery time set by each seller';
  };
  // A pickup choice that stopped being offered (cart changed) falls back to the door.
  const method: 'door' | PickupKind = deliveryMethod !== 'door' && pickupOffers[deliveryMethod] === null ? 'door' : deliveryMethod;

  // The preview only counts while the cart is the one it was checked against.
  const discountActive = appliedDiscount && appliedDiscount.cartSig === cartSig ? appliedDiscount : null;
  const discountCents = discountActive?.discountCents ?? 0;
  const applyDiscount = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/discounts/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: discountInput }) });
      const out = await readJson(res);
      if (!res.ok) throw new Error(out.error ?? 'This code could not be applied');
      return out as { code: string; discountCents: number; applies: { storeName: string; discountCents: number; label: string }[]; problems: { storeName: string; reason: string }[] };
    },
    onSuccess: (out) => setAppliedDiscount({ ...out, cartSig }),
    onError: (e: Error) => {
      setAppliedDiscount(null);
      toast({ title: 'Discount code', description: e.message, variant: 'destructive' });
    },
  });

  // Quote the address once typing pauses — one courier request per address,
  // not one per keystroke. Typing an address used to fire 30+ quotes in a few
  // seconds, hit the per-IP limit and show "could not get courier rates".
  const [quoteAddress, setQuoteAddress] = useState(address);
  useEffect(() => {
    if (address === quoteAddress) return;
    const t = setTimeout(() => setQuoteAddress(address), 700);
    return () => clearTimeout(t);
  }, [address, quoteAddress]);
  const quotePending = address !== quoteAddress;

  const shipping = useQuery<{ options: ShippingOption[]; sellerCount?: number }>({
    queryKey: ['shipping', sellerLocation, quoteAddress, pin?.latitude, pin?.longitude, lines.map((l) => `${l.productId}:${l.variantId ?? ''}:x${l.quantity}`).join('|')],
    queryFn: async () => {
      const res = await fetch('/api/shipping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sellerLocation,
          address: quoteAddress,
          // Real cart items: the server builds the courier parcels from each
          // seller's declared weight + box size (never trusted from here).
          items: lines.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity })),
          latitude: pin?.latitude,
          longitude: pin?.longitude,
        }),
      });
      if (!res.ok) throw new Error('Could not quote delivery');
      return readJson(res);
    },
    enabled: Boolean(session) && quoteAddress.trim().length >= 5 && method === 'door',
  });

  // The option actually charged: the buyer's pick when it is on offer, else
  // the first (cheapest) one — the same rule /api/checkout applies.
  const chosenShippingCode = shipping.data?.options.some((o) => o.code === shippingCode)
    ? shippingCode
    : (shipping.data?.options[0]?.code ?? shippingCode);
  const courierCents = shipping.data?.options.find((o) => o.code === chosenShippingCode)?.priceCents ?? 0;
  const shippingCents = method === 'door' ? courierCents : (pickupOffers[method] ?? 0);
  const orderTotal = subtotal - discountCents + shippingCents;

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
          buyerName, buyerEmail, buyerPhone, idempotencyKey,
          // Pickup: the "address" is the PAXI point / Pudo locker the buyer chose.
          address: method === 'door' ? address : pickupPoint,
          shippingCode: method === 'door' ? chosenShippingCode : method,
          discountCode: discountActive?.code,
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
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error ?? 'Checkout failed');
      return data as { orders: { number: string; totalCents: number; paymentUrl?: string; paymentKind?: string; store?: { name?: string; payoutProvider?: string | null; payoutLink?: string | null; payoutNote?: string | null; payfastReady?: boolean; ozowReady?: boolean; yocoReady?: boolean; eft?: EftDetailsDto | null } }[]; payments?: { payfast?: boolean; ggpay?: boolean } };
    },
    onSuccess: (data) => {
      setPlaced(data.orders);
      setPayfastFlag(Boolean(data.payments?.payfast));
      setGgpayFlag(Boolean(data.payments?.ggpay));
      queryClient.invalidateQueries({ queryKey: ['cart'] });
      // The server just created order notifications — refresh the bell's badge.
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      // Pay immediately, like a big online shop: one seller → straight to that
      // seller's secure payment page. Several sellers → one payment each, from
      // the confirmation below. If nothing can open, the buttons stay.
      if (data.orders.length === 1) {
        setPayingNow(true);
        void payOrderNow(data.orders[0], Boolean(data.payments?.payfast)).then((leaving) => { if (!leaving) setPayingNow(false); });
      } else {
        toast({ title: 'Orders placed', description: 'Pay each seller below — every payment confirms its order at once.' });
      }
    },
    onError: (e: Error) => {
      // A 409 here means the server just cleaned the stored cart (dead rows
      // removed / quantities clamped) — refresh so the retry sees it instantly.
      queryClient.invalidateQueries({ queryKey: ['cart'] });
      toast({ title: 'Checkout', description: e.message, variant: 'destructive' });
    },
  });

  if (placed) {
    return (
      <div className="rounded-lg border bg-card p-6">
        <h2 className="text-lg font-bold">Order placed — pay now to confirm</h2>
        {payingNow && (
          <p className="mt-2 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-2 text-sm font-medium" role="status" data-testid="paying-now">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Taking you to secure payment…
          </p>
        )}
        <p className="mt-1 text-sm text-muted-foreground">
          Pay on the seller's secure payment page and each order confirms automatically — the seller is notified straight away and ships it.
        </p>
        <ul className="mt-4 space-y-3">
          {placed.map((o) => (
            <li key={o.number} className="rounded-md border bg-secondary px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-mono font-bold text-primary">{o.number}</span>
                <span className="font-semibold">{formatMoney(o.totalCents)}</span>
              </div>
              {/* GGPay — the marketplace's in-app payment system: pay INSIDE
                  the app; the order confirms automatically on approval. */}
              {!paidNums.includes(o.number) ? (
                ggpayFlag && <div className="mt-3">
                  <GgPayCardForm
                    orderNumber={o.number}
                    totalCents={o.totalCents}
                    onPaid={() => {
                      setPaidNums((prev) => [...prev, o.number]);
                      queryClient.invalidateQueries({ queryKey: ['orders'] });
                    }}
                  />
                </div>
              ) : (
                <p className="mt-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs font-semibold text-primary">Paid in full — order confirmed ✓</p>
              )}
              {/* Seller-owned processors — PayFast / Ozow on the processor's
                  secure page; the buyer returns to their orders afterwards. */}
              {!paidNums.includes(o.number) && (
                <div className="mt-3">
                  <SellerPayButtons
                    orderNumber={o.number}
                    payfastReady={o.store?.payfastReady}
                    ozowReady={o.store?.ozowReady}
                  />
                </div>
              )}
              {/* In-system card checkout: the server created a real Yoco session
                  for THIS order (Mastercard & Visa accepted) — pay immediately. */}
              {(o.paymentUrl || o.store?.yocoReady) && (
                <div className="mt-2 border-t pt-2">
                  <a
                    href={o.paymentUrl ?? `/api/payments/yoco/start?number=${encodeURIComponent(o.number)}`}
                    target={o.paymentUrl ? '_blank' : undefined}
                    rel={o.paymentUrl ? 'noopener noreferrer' : undefined}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                  >
                    <span aria-hidden="true"><YocoLogo /></span> Or pay with card on the seller's Yoco page ↗
                  </a>
                </div>
              )}
              {payfastFlag && (
                <div className="mt-2 border-t pt-2">
                  <a href={`/api/payments/payfast/start?number=${encodeURIComponent(o.number)}`} className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
                    <span aria-hidden="true"><PayFastLogo /></span> Or pay with PayFast (card / instant EFT) ↗
                  </a>
                </div>
              )}
              {/* Buyers pay only through the seller's processor (owner's rule:
                  no bank transfers, no pasted payment links). */}
              {!paidNums.includes(o.number) && !o.store?.payfastReady && !o.store?.ozowReady && !o.store?.yocoReady && !o.paymentUrl && !payfastFlag && (
                <div className="mt-2"><p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">This seller has not connected an online payment processor, so this order can&apos;t be paid online. Unpaid orders are cancelled automatically.</p></div>
              )}
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
    <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr] [&>*]:min-w-0">
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
        {(pickupOffers.paxi !== null || pickupOffers.pudo !== null) && (
          <div data-testid="delivery-method">
            <Label className="text-sm">How would you like to receive it?</Label>
            <RadioGroup className="mt-2 space-y-2" value={method} onValueChange={(v) => setDeliveryMethod(v as 'door' | PickupKind)}>
              <Label htmlFor="dm-door" className="flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm hover:bg-accent/40">
                <RadioGroupItem id="dm-door" value="door" />
                <span className="flex-1"><span className="font-medium">Courier to my door</span><span className="block text-xs text-muted-foreground">Quoted for your address below</span></span>
              </Label>
              {(['paxi', 'pudo'] as PickupKind[]).filter((k) => pickupOffers[k] !== null).map((k) => (
                <Label key={k} htmlFor={`dm-${k}`} className="flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm hover:bg-accent/40">
                  <RadioGroupItem id={`dm-${k}`} value={k} />
                  <span className="flex-1"><span className="font-medium">{PICKUP_INFO[k].label}</span><span className="block text-xs text-muted-foreground">{pickupEta(k)}</span></span>
                  <span className="font-semibold">{formatMoney(pickupOffers[k] ?? 0)}</span>
                </Label>
              ))}
            </RadioGroup>
          </div>
        )}
        {method !== 'door' ? (
          <div>
            <Label htmlFor="co-pickup">{PICKUP_INFO[method].point} you will collect from</Label>
            <Input
              id="co-pickup"
              value={pickupPoint}
              onChange={(e) => setPickupPoint(e.target.value.slice(0, 200))}
              placeholder={method === 'paxi' ? 'e.g. PEP Soweto Maponya Mall — PAXI point code' : 'e.g. Pudo locker name and address'}
              required
              minLength={6}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Choose your point on{' '}
              <a href={PICKUP_INFO[method].finderUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{PICKUP_INFO[method].finderLabel.replace(/^Find a [^ ]+ (point|locker) on /, '')} ↗</a>
              {' '}and type its name or code here. The seller sends your parcel there; you collect it with the details the provider sends you.
            </p>
          </div>
        ) : (
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
        )}

        {method === 'door' && <div>
          <Label className="text-sm">Delivery option</Label>
          {address.trim().length < 5 ? (
            <p className="mt-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">Enter the delivery address to see courier options.</p>
          ) : shipping.isLoading || quotePending ? (
            <p className="mt-2 text-xs text-muted-foreground">Fetching courier rates…</p>
          ) : shipping.isError ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 p-3 text-xs" role="alert">
              <span className="flex-1">We could not get courier rates right now.</span>
              <Button type="button" size="sm" variant="outline" onClick={() => shipping.refetch()}>Try again</Button>
            </div>
          ) : (
            <RadioGroup className="mt-2 space-y-2" value={chosenShippingCode} onValueChange={setShippingCode}>
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
          {(shipping.data?.sellerCount ?? 1) > 1 && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Your cart comes from {shipping.data?.sellerCount} sellers. Each one ships separately, so delivery is the total of their courier quotes.
            </p>
          )}
        </div>}
        {method !== 'door' && cartStores.length > 1 && (
          <p className="text-[11px] text-muted-foreground">Your cart comes from {cartStores.length} sellers. Each one sends a parcel to your {PICKUP_INFO[method].point}, so delivery is the total of their prices.</p>
        )}

        <Button type="submit" size="lg" className="w-full" disabled={placeOrder.isPending}>
          {placeOrder.isPending ? 'Placing order…' : `Place order & pay — ${formatMoney(orderTotal)}`}
        </Button>
        <p className="text-center text-[11px] text-muted-foreground">
          You go straight to the seller's secure PayFast, Ozow or Yoco payment (card or instant EFT) — your order confirms the moment you pay. No bank transfers. Totals are recalculated securely on the server.
        </p>
        <p className="text-center text-[11px] text-muted-foreground" data-testid="no-refunds-note">
          <strong className="text-foreground">All sales are final — no refunds for change of mind.</strong> Your legal rights for faulty, wrong or undelivered items and the 7-day cooling-off for online orders still apply.{' '}
          <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={showRefundPolicy}>Refund policy</button>
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
        {discountActive && (
          <div className="flex justify-between text-sm text-primary" data-testid="discount-line"><span>Discount {discountActive.code}</span><span>−{formatMoney(discountActive.discountCents)}</span></div>
        )}
        <div className="flex justify-between text-sm"><span className="text-muted-foreground">Delivery</span><span>{shippingCents ? formatMoney(shippingCents) : '—'}</span></div>
        <div className="mt-2 flex justify-between border-t pt-2 text-base font-bold"><span>Total</span><span>{formatMoney(orderTotal)}</span></div>
        {cartStores.some((st) => st.hasDiscounts) && <div className="mt-4" data-testid="discount-box">
          <Label htmlFor="co-discount" className="text-xs">Discount code</Label>
          <div className="mt-1 flex gap-2">
            <Input
              id="co-discount"
              value={discountInput}
              onChange={(e) => setDiscountInput(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20))}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (discountInput.length >= 3) applyDiscount.mutate(); } }}
              placeholder="Enter a code"
              aria-describedby="co-discount-note"
            />
            <Button type="button" variant="outline" onClick={() => applyDiscount.mutate()} disabled={discountInput.length < 3 || applyDiscount.isPending}>
              {applyDiscount.isPending ? 'Checking…' : 'Apply'}
            </Button>
          </div>
          {discountActive ? (
            <div id="co-discount-note" className="mt-1 text-[11px] text-muted-foreground">
              {discountActive.applies.map((a) => <p key={a.storeName}>{a.label} {a.storeName}&apos;s items: −{formatMoney(a.discountCents)}</p>)}
              {discountActive.problems.map((pr) => <p key={pr.storeName}>{pr.storeName}: {pr.reason}</p>)}
              <button type="button" className="text-primary hover:underline" onClick={() => { setAppliedDiscount(null); setDiscountInput(''); }}>Remove code</button>
            </div>
          ) : (
            <p id="co-discount-note" className="mt-1 text-[11px] text-muted-foreground">Codes come from sellers and apply to that seller&apos;s items.</p>
          )}
        </div>}
      </aside>
    </div>
  );
}
