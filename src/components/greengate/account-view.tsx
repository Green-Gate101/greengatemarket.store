'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { Package, Heart, User as UserIcon, ChevronDown, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { formatMoney, formatDateTime, ORDER_STATUS_LABELS, PAYMENT_PROVIDER_LABELS, SALE_STATUSES, type OrderDto, type WishlistLineDto } from '@/lib/types';
import { navigate } from './header';
import { CheckoutPanel } from './cart-sheet';
import { GgPayCardForm } from './ggpay-card-form';
import { SellerPayButtons } from './in-app-pay';
import { PayFastLogo, YocoLogo, ProcessorLogo, BankLogo } from './payment-logos';
import { AddressesPanel } from './addresses-panel';

interface MeResponse {
  user: { id: string; email: string; name: string | null; role: string; emailVerified: boolean; phone: string | null } | null;
}

export function AccountView({ initialTab = 'checkout' }: { initialTab?: string }) {
  const { data: session, status } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const me = useQuery<MeResponse>({
    queryKey: ['profile'],
    queryFn: async () => (await fetch('/api/auth/me')).json(),
  });

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  const saveProfile = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not save');
      return data;
    },
    onSuccess: () => {
      toast({ title: 'Profile updated' });
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: (e: Error) => toast({ title: 'Profile', description: e.message, variant: 'destructive' }),
  });

  if (status === 'loading') {
    return <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-12"><p className="text-sm text-muted-foreground">Loading…</p></main>;
  }

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center gap-4 px-4 py-20 text-center">
        <UserIcon className="h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">Sign in to manage your account</p>
        <p className="text-xs text-muted-foreground">Track orders, save products to your wishlist and check out securely.</p>
        <Button onClick={() => navigate({ name: 'signin' })}>Sign in</Button>
      </main>
    );
  }

  const user = me.data?.user;
  const role = user?.role ?? 'BUYER';
  const knownName = name || user?.name || '';
  const knownPhone = phone || user?.phone || '';

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
      <Tabs defaultValue={initialTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="checkout"><Package className="mr-1.5 h-4 w-4" /> Checkout</TabsTrigger>
          <TabsTrigger value="addresses"><MapPin className="mr-1.5 h-4 w-4" /> Addresses</TabsTrigger>
          <TabsTrigger value="orders">My orders</TabsTrigger>
          <TabsTrigger value="wishlist"><Heart className="mr-1.5 h-4 w-4" /> Wishlist</TabsTrigger>
          <TabsTrigger value="profile">Profile</TabsTrigger>
        </TabsList>

        <TabsContent value="checkout" className="mt-4">
          <CheckoutPanel />
        </TabsContent>

        <TabsContent value="addresses" className="mt-4">
          <AddressesPanel />
        </TabsContent>

        <TabsContent value="orders" className="mt-4">
          <OrdersList />
        </TabsContent>

        <TabsContent value="wishlist" className="mt-4">
          <WishlistPanel />
        </TabsContent>

        <TabsContent value="profile" className="mt-4">
          <div className="max-w-xl space-y-4 rounded-lg border bg-card p-6">
            <div>
              <p className="text-lg font-bold">{user?.name ?? session.user?.name}</p>
              <p className="text-sm text-muted-foreground">{user?.email}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Badge variant="secondary">{role}</Badge>
                {user?.emailVerified
                  ? <Badge variant="outline" className="text-primary">Email verified</Badge>
                  : <Badge variant="outline" className="text-destructive">Email not verified</Badge>}
              </div>
              {!user?.emailVerified && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={async () => {
                    const res = await fetch('/api/auth/verify', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ email: user?.email }),
                    });
                    const data = await res.json();
                    toast({ title: 'Verification', description: data.message ?? data.error });
                  }}
                >
                  Resend verification email
                </Button>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="acc-name">Full name</Label>
                <Input id="acc-name" value={knownName} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="acc-phone">Phone</Label>
                <Input id="acc-phone" type="tel" value={knownPhone} onChange={(e) => setPhone(e.target.value)} />
              </div>
            </div>
            <Button onClick={() => saveProfile.mutate()} disabled={saveProfile.isPending}>
              {saveProfile.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </main>
  );
}

function OrdersList() {
  const { toast } = useToast();
  const { data, isLoading, isError } = useQuery<{ orders: OrderDto[]; payments?: { payfast?: boolean } }>({
    queryKey: ['orders'],
    queryFn: async () => {
      const res = await fetch('/api/orders');
      if (!res.ok) throw new Error('Could not load orders');
      return res.json();
    },
  });

  const [open, setOpen] = useState<string | null>(null);

  if (isLoading) return <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />)}</div>;
  if (isError) return <p className="rounded-lg border p-6 text-sm text-muted-foreground">Could not load your orders. Please try again.</p>;
  if (!data || data.orders.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-10 text-center">
        <Package className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="mt-2 text-sm font-medium">No orders yet</p>
        <p className="mt-1 text-xs text-muted-foreground">When you place an order it will appear here with live status tracking.</p>
        <Button className="mt-4" variant="outline" onClick={() => navigate({ name: 'store' })}>Browse products</Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {data.orders.map((order) => (
        <article key={order.id} className="rounded-lg border bg-card">
          <button
            className="flex w-full flex-wrap items-center gap-3 p-4 text-left"
            onClick={() => setOpen(open === order.id ? null : order.id)}
            aria-expanded={open === order.id}
          >
            <div className="flex-1">
              <p className="font-mono text-sm font-bold text-primary">{order.number}</p>
              <p className="text-xs text-muted-foreground">{formatDateTime(order.createdAt)} · {order.store?.name}</p>
            </div>
            <Badge variant={order.status === 'delivered' ? 'default' : order.status === 'cancelled' ? 'destructive' : 'secondary'}>
              {ORDER_STATUS_LABELS[order.status as keyof typeof ORDER_STATUS_LABELS] ?? order.status}
            </Badge>
            <span className="text-sm font-bold">{formatMoney(order.totalCents)}</span>
            <ChevronDown className={`h-4 w-4 transition-transform ${open === order.id ? 'rotate-180' : ''}`} />
          </button>
          {open === order.id && <OrderDetail id={order.id} onToast={toast} />}
        </article>
      ))}
    </div>
  );
}

function OrderDetail({ id, onToast }: { id: string; onToast: ReturnType<typeof useToast>['toast'] }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<{ order: OrderDto & { events: { id: string; status: string; note: string | null; createdAt: string }[] }; payments?: { payfast?: boolean } }>({
    queryKey: ['order', id],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${id}`);
      if (!res.ok) throw new Error('not found');
      return res.json();
    },
  });

  if (isLoading || !data) {
    return (
      <div className="space-y-2 border-t px-4 pb-4 pt-3" aria-busy="true">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  const order = data.order;

  return (
    <div className="border-t px-4 pb-4 pt-3">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Items</p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {order.items.map((item) => (
              <li key={item.id} className="flex justify-between gap-2">
                <span className="min-w-0 truncate">{item.quantity} × {item.name}{item.variantLabel ? ` (${item.variantLabel})` : ''}</span>
                <span>{formatMoney(item.unitPriceCents * item.quantity)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">Delivery: {order.shippingMethod} — {formatMoney(order.shippingCents)} · Total {formatMoney(order.totalCents)}</p>
          <p className="mt-1 text-xs text-muted-foreground">Deliver to: {order.address}</p>
          {typeof order.deliveryLat === 'number' && typeof order.deliveryLng === 'number' && (
            <p className="mt-1 text-xs">
              <a
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                href={`https://www.google.com/maps?q=${order.deliveryLat},${order.deliveryLng}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                📍 Courier pin ({order.deliveryLat.toFixed(5)}, {order.deliveryLng.toFixed(5)}) — open map
              </a>
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">Payment: bank transfer · {order.paymentStatus.replace('_', ' ')}{order.paymentRef ? ` · ref ${order.paymentRef}` : ''}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status timeline</p>
          <ol className="mt-2 space-y-2">
            {order.events.map((ev) => (
              <li key={ev.id} className="flex gap-2 text-sm">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-sm bg-primary" aria-hidden />
                <div>
                  <p className="font-medium">{ORDER_STATUS_LABELS[ev.status as keyof typeof ORDER_STATUS_LABELS] ?? ev.status}</p>
                  {ev.note && <p className="text-xs text-muted-foreground">{ev.note}</p>}
                  <p className="text-[11px] text-muted-foreground">{formatDateTime(ev.createdAt)}</p>
                </div>
              </li>
            ))}
          </ol>
          {!SALE_STATUSES.includes(order.status as never) && order.status === 'pending_payment' && (
            <div className="mt-3 space-y-2">
              {/* GGPay — pay INSIDE the app; the order confirms automatically. */}
              <GgPayCardForm
                orderNumber={order.number}
                totalCents={order.totalCents}
                onPaid={() => {
                  queryClient.invalidateQueries({ queryKey: ['order', id] });
                  queryClient.invalidateQueries({ queryKey: ['orders'] });
                }}
              />
              {/* Seller-owned processors — IN-APP PayFast Onsite + Ozow instant
                  EFT: pay right here in a secure in-app frame. */}
              <SellerPayButtons
                orderNumber={order.number}
                payfastReady={order.store?.payfastReady}
                ozowReady={order.store?.ozowReady}
              />
              {(order.store?.payoutProvider === 'yoco' || order.store?.payoutProvider === 'mastercard') && (
                <a
                  href={`/api/payments/yoco/start?number=${encodeURIComponent(order.number)}`}
                  className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-xs font-semibold text-primary hover:underline"
                >
                  <span aria-hidden="true"><YocoLogo /></span> Or pay with card (Mastercard &amp; Visa) on the seller's Yoco page ↗
                </a>
              )}
              {data.payments?.payfast && (
                <a
                  href={`/api/payments/payfast/start?number=${encodeURIComponent(order.number)}`}
                  className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-xs font-semibold text-primary hover:underline"
                >
                  <span aria-hidden="true"><PayFastLogo /></span> Or pay with PayFast (card / instant EFT) ↗
                </a>
              )}
              {order.store?.payoutLink && (
                <a
                  href={`${order.store.payoutLink}${order.store.payoutLink.includes('?') ? '&' : '?'}ref=${encodeURIComponent(order.number)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-xs font-semibold text-primary hover:underline"
                >
                  <span aria-hidden="true"><ProcessorLogo provider={order.store.payoutProvider ?? 'other'} /></span> Or pay on {PAYMENT_PROVIDER_LABELS[order.store.payoutProvider ?? 'other'] ?? 'the seller’s payment page'} ↗
                </a>
              )}
              <p className="rounded-md bg-secondary p-3 text-xs text-muted-foreground">
                <span aria-hidden="true" className="mr-1.5"><BankLogo /></span>Prefer EFT? Pay by bank transfer using order number <span className="font-mono font-bold">{order.number}</span> as reference. The seller confirms receipt and the timeline updates.
              </p>
            </div>
          )}
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="mt-3"
        onClick={async () => {
          await navigator.clipboard.writeText(order.number).catch(() => undefined);
          onToast({ title: 'Order number copied' });
        }}
      >
        Copy order number
      </Button>
    </div>
  );
}

function WishlistPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<{ items: WishlistLineDto[] }>({
    queryKey: ['wishlist'],
    queryFn: async () => {
      const res = await fetch('/api/wishlist');
      if (!res.ok) throw new Error('not found');
      return res.json();
    },
  });

  const remove = useMutation({
    mutationFn: async (productId: string) => {
      const res = await fetch('/api/wishlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId }),
      });
      if (!res.ok) throw new Error('failed');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['wishlist'] }),
  });

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)}
      </div>
    );
  }
  if (!data || data.items.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-10 text-center">
        <Heart className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="mt-2 text-sm font-medium">Your wishlist is empty</p>
        <p className="mt-1 text-xs text-muted-foreground">Tap the heart on any product to save it here.</p>
        <Button className="mt-4" variant="outline" onClick={() => navigate({ name: 'store' })}>Find something you love</Button>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {data.items.map((item) => (
        <article key={item.id} className="flex gap-3 rounded-lg border bg-card p-3">
          <button className="h-20 w-20 shrink-0 overflow-hidden rounded-md border bg-white dark:bg-muted" onClick={() => navigate({ name: 'product', slug: item.slug })}>
            {item.image ? (
               
              <img src={item.image} alt={item.name} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">No image</div>
            )}
          </button>
          <div className="min-w-0 flex-1">
            <button className="line-clamp-2 text-left text-sm font-medium hover:text-primary" onClick={() => navigate({ name: 'product', slug: item.slug })}>
              {item.name}
            </button>
            <p className="text-xs text-muted-foreground">{item.storeName}</p>
            <p className="mt-1 text-sm font-bold">{formatMoney(item.salePriceCents ?? item.priceCents)}</p>
            <div className="mt-1 flex gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={async () => {
                  const res = await fetch('/api/cart', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ productId: item.productId, quantity: 1 }),
                  });
                  if (res.ok) {
                    toast({ title: 'Added to cart', description: item.name });
                    queryClient.invalidateQueries({ queryKey: ['cart'] });
                  } else {
                    const err = await res.json();
                    toast({ title: 'Cart', description: err.error, variant: 'destructive' });
                  }
                }}
                disabled={item.stock <= 0}
              >
                {item.stock <= 0 ? 'Sold out' : 'Move to cart'}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={() => remove.mutate(item.productId)}>
                Remove
              </Button>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
