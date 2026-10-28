'use client';

import { useState } from 'react';
import { useMutation, useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { Package, Heart, User as UserIcon, ChevronDown, MapPin, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { formatMoney, formatDateTime, ORDER_STATUS_LABELS, SALE_STATUSES, RETURN_REASONS, RETURN_REASON_LABELS, RETURN_STATUS_LABELS, RETURN_RESOLUTION_LABELS, type OrderDto, type WishlistLineDto, type ReturnReportDto, type ReturnReason } from '@/lib/types';
import { navigate } from './header';
import { CheckoutPanel } from './cart-sheet';
import { GgPayCardForm } from './ggpay-card-form';
import { SellerPayButtons } from './in-app-pay';
import { PayFastLogo, YocoLogo } from './payment-logos';
import { AddressesPanel } from './addresses-panel';
import { readJson, sizedImage } from '@/lib/utils';
import { rememberReturnTo } from './return-route';

interface MeResponse {
  user: { id: string; email: string; name: string | null; role: string; emailVerified: boolean; phone: string | null } | null;
}

export function AccountView({ initialTab = 'checkout' }: { initialTab?: string }) {
  const { data: session, status } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const me = useQuery<MeResponse>({
    queryKey: ['profile'],
    queryFn: async () => readJson(await fetch('/api/auth/me')),
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
      const data = await readJson(res);
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
        <p className="text-sm font-medium">{initialTab === 'checkout' ? 'Sign in to check out' : 'Sign in to see your account'}</p>
        <p className="text-xs text-muted-foreground">Your cart is kept — after you sign in you come straight back here.</p>
        <Button
          onClick={() => {
            rememberReturnTo(initialTab === 'orders' ? '#/orders' : initialTab === 'wishlist' ? '#/wishlist' : '#/account');
            navigate({ name: 'signin' });
          }}
        >
          Sign in
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            rememberReturnTo(initialTab === 'orders' ? '#/orders' : initialTab === 'wishlist' ? '#/wishlist' : '#/account');
            navigate({ name: 'register' });
          }}
        >
          Create a free account
        </Button>
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
                    try {
                      const res = await fetch('/api/auth/verify', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: user?.email }),
                      });
                      const data = await readJson(res);
                      toast({ title: 'Verification', description: data.message ?? data.error });
                    } catch {
                      toast({ title: 'Verification', description: 'Network problem — please try again.', variant: 'destructive' });
                    }
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
  // Real pagination: the first page loads with the list; "Load more" pages
  // through older orders via ?offset= (the API caps each page at 200).
  const { data, isLoading, isError, fetchNextPage, isFetchingNextPage, hasNextPage } = useInfiniteQuery<{
    orders: OrderDto[]; total: number; hasMore: boolean; payments?: { payfast?: boolean };
  }>({
    queryKey: ['orders'],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const res = await fetch(`/api/orders?offset=${pageParam}`);
      if (!res.ok) throw new Error('Could not load orders');
      return readJson(res);
    },
    getNextPageParam: (last, all) => (last.hasMore ? all.reduce((n, p) => n + p.orders.length, 0) : undefined),
  });

  const [open, setOpen] = useState<string | null>(null);

  if (isLoading) return <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />)}</div>;
  if (isError) return <p className="rounded-lg border p-6 text-sm text-muted-foreground">Could not load your orders. Please try again.</p>;
  const orders = data?.pages.flatMap((p) => p.orders) ?? [];
  if (orders.length === 0) {
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
      {orders.map((order) => (
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
      {hasNextPage && (
        <Button
          variant="outline"
          className="w-full"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          {isFetchingNextPage ? 'Loading…' : `Load more orders${data?.pages[0]?.total ? ` (${data.pages[0].total} total)` : ''}`}
        </Button>
      )}
    </div>
  );
}

function OrderDetail({ id, onToast }: { id: string; onToast: ReturnType<typeof useToast>['toast'] }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<{ order: OrderDto & { events: { id: string; status: string; note: string | null; createdAt: string }[] }; returnReports?: ReturnReportDto[]; payments?: { payfast?: boolean; ggpay?: boolean } }>({
    queryKey: ['order', id],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${id}`);
      if (!res.ok) throw new Error('not found');
      return readJson(res);
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
          <p className="mt-2 text-xs text-muted-foreground">Delivery: {order.shippingMethod} — {formatMoney(order.shippingCents)}{order.discountCents ? <> · Discount {order.discountCode} −{formatMoney(order.discountCents)}</> : null} · Total {formatMoney(order.totalCents)}</p>
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
          <p className="mt-1 text-xs text-muted-foreground">Payment: {order.paymentStatus.replace(/_/g, ' ')}{order.paymentRef ? ` · ref ${order.paymentRef}` : ''}</p>
          <CourierTracking orderId={order.id} paid={order.paymentStatus === 'paid'} />
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
              {/* GGPay in-app card — the order confirms automatically.
                  Shown only while the engine can really take a payment. */}
              {data.payments?.ggpay && (
                <GgPayCardForm
                  orderNumber={order.number}
                  totalCents={order.totalCents}
                  onPaid={() => {
                    queryClient.invalidateQueries({ queryKey: ['order', id] });
                    queryClient.invalidateQueries({ queryKey: ['orders'] });
                  }}
                />
              )}
              {/* Seller-owned processors — PayFast / Ozow on the processor's
                  secure page; the buyer returns here afterwards. */}
              <SellerPayButtons
                orderNumber={order.number}
                payfastReady={order.store?.payfastReady}
                ozowReady={order.store?.ozowReady}
              />
              {order.store?.yocoReady && (
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
              {/* Buyers pay only through the seller's processor (owner's rule). */}
              {!order.store?.payfastReady && !order.store?.ozowReady && !order.store?.yocoReady && !data.payments?.payfast && !data.payments?.ggpay && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">This seller has not connected an online payment processor, so this order can&apos;t be paid online. Unpaid orders are cancelled automatically.</p>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Buyer-only return reports (RET-1): only the customer can report an
          item "not as seen" — Green Gate does not do refunds. */}
      <ReturnReportsSection order={order} reports={data.returnReports ?? []} onToast={onToast} />
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

/**
 * ReturnReportsSection — the buyer's own return reports on this order.
 *
 * Owner policy (RET-1): ONLY the customer can report an item they did not
 * expect ("not as seen"), and Green Gate does NOT do refunds — approved
 * reports are resolved with a replacement or store credit by the
 * administrator. This section is render-only for sellers; the server refuses
 * every non-buyer write regardless of what the UI shows.
 */
function ReturnReportsSection({ order, reports, onToast }: { order: OrderDto; reports: ReturnReportDto[]; onToast: ReturnType<typeof useToast>['toast'] }) {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [reason, setReason] = useState<ReturnReason>('not_as_seen');
  const [itemIdx, setItemIdx] = useState('');
  const [desc, setDesc] = useState('');

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['order', order.id] });
    queryClient.invalidateQueries({ queryKey: ['orders'] });
    queryClient.invalidateQueries({ queryKey: ['returns'] });
  };

  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: order.id,
          reason,
          description: desc,
          ...(itemIdx === '' ? {} : { orderItemId: order.items[Number(itemIdx)]?.id }),
        }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error ?? 'Could not open the report');
      return data;
    },
    onSuccess: () => {
      onToast({ title: 'Report received', description: 'We will get back to you here — watch this order and your notifications.' });
      setFormOpen(false); setDesc(''); setItemIdx(''); setReason('not_as_seen');
      refresh();
    },
    onError: (e: Error) => onToast({ title: 'Report', description: e.message, variant: 'destructive' }),
  });

  const act = useMutation({
    mutationFn: async ({ reportId, action }: { reportId: string; action: 'withdraw' | 'mark_sent_back' }) => {
      const res = await fetch(`/api/returns/${reportId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error ?? 'Could not update the report');
      return data;
    },
    onSuccess: (_d, v) => {
      onToast({ title: v.action === 'withdraw' ? 'Report withdrawn' : 'Marked as sent back' });
      refresh();
    },
    onError: (e: Error) => onToast({ title: 'Report', description: e.message, variant: 'destructive' }),
  });

  // Mirror of the server's eligibility rule — a hint only; the API enforces it.
  const canReport = order.paymentStatus === 'paid' && order.status !== 'cancelled';
  const hasOpen = reports.some((r) => r.status === 'open');

  return (
    <div className="mt-4 rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Return or report a problem</p>
        {canReport && !hasOpen && !formOpen && (
          <Button size="sm" variant="outline" onClick={() => setFormOpen(true)}>
            Report an item not as seen
          </Button>
        )}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Only you, the customer, can report a problem with this order. Green Gate does not offer refunds — approved reports are sorted out with a replacement or store credit.
      </p>

      {formOpen && (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => { e.preventDefault(); if (!create.isPending && desc.trim().length >= 10) create.mutate(); }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor={`rr-reason-${order.id}`} className="text-xs">What is wrong?</Label>
              <select
                id={`rr-reason-${order.id}`}
                value={reason}
                onChange={(e) => setReason(e.target.value as ReturnReason)}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                {RETURN_REASONS.map((r) => <option key={r} value={r}>{RETURN_REASON_LABELS[r]}</option>)}
              </select>
            </div>
            {order.items.length > 1 && (
              <div>
                <Label htmlFor={`rr-item-${order.id}`} className="text-xs">Which item? (optional)</Label>
                <select
                  id={`rr-item-${order.id}`}
                  value={itemIdx}
                  onChange={(e) => setItemIdx(e.target.value)}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                >
                  <option value="">The whole order / not sure</option>
                  {order.items.map((it, i) => <option key={it.id} value={String(i)}>{it.quantity} × {it.name}</option>)}
                </select>
              </div>
            )}
          </div>
          <div>
            <Label htmlFor={`rr-desc-${order.id}`} className="text-xs">Tell us what happened</Label>
            <Textarea
              id={`rr-desc-${order.id}`}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Describe what you received versus what you saw on the listing…"
              className="mt-1"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={create.isPending || desc.trim().length < 10}>
              {create.isPending ? 'Sending…' : 'Send report'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setFormOpen(false)} disabled={create.isPending}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {reports.length > 0 && (
        <ul className="mt-3 space-y-2">
          {reports.map((r) => (
            <li key={r.id} className="rounded-md border bg-card p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-bold text-primary">{r.reference}</span>
                <Badge variant={r.status === 'resolved' ? 'default' : r.status === 'rejected' || r.status === 'closed' ? 'outline' : 'secondary'}>
                  {RETURN_STATUS_LABELS[r.status] ?? r.status}
                </Badge>
                {r.resolution && (
                  <Badge variant="secondary" className="bg-primary/10 text-primary">{RETURN_RESOLUTION_LABELS[r.resolution] ?? r.resolution}</Badge>
                )}
                <span className="ml-auto text-[11px] text-muted-foreground">{formatDateTime(r.createdAt)}</span>
              </div>
              <p className="mt-1 text-xs font-medium">{RETURN_REASON_LABELS[r.reason] ?? r.reason}</p>
              <p className="mt-0.5 text-xs text-muted-foreground" style={{ overflowWrap: 'anywhere' }}>{r.description}</p>
              {r.adminNote && <p className="mt-1 rounded-md bg-muted px-2 py-1 text-xs">Message from us: {r.adminNote}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                {r.status === 'open' && (
                  <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ reportId: r.id, action: 'withdraw' })}>
                    Withdraw report
                  </Button>
                )}
                {r.status === 'approved' && (
                  <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ reportId: r.id, action: 'mark_sent_back' })}>
                    I&apos;ve sent it back
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WishlistPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Real pagination: page one loads with the panel; "Load more" pages deeper
  // via ?offset= (the API caps each page at 300 saves).
  const { data, isLoading, isError, isFetching, refetch, fetchNextPage, isFetchingNextPage, hasNextPage } = useInfiniteQuery<{
    items: WishlistLineDto[]; total: number; hasMore: boolean;
  }>({
    queryKey: ['wishlist'],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const res = await fetch(`/api/wishlist?offset=${pageParam}`);
      if (!res.ok) throw new Error('not found');
      return readJson(res);
    },
    getNextPageParam: (last, all) => (last.hasMore ? all.reduce((n, p) => n + p.items.length, 0) : undefined),
  });

  const remove = useMutation({
    mutationFn: async (productId: string) => {
      const res = await fetch('/api/wishlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId }),
      });
      if (!res.ok) throw new Error('failed');
      return readJson(res);
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
  const items = data?.pages.flatMap((p) => p.items) ?? [];
  // A failed load must not read as "Your wishlist is empty".
  if (isError && items.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-10 text-center">
        <p className="text-sm font-medium">We could not load your wishlist right now</p>
        <Button className="mt-4" variant="outline" onClick={() => void refetch()} disabled={isFetching}>{isFetching ? 'Trying again…' : 'Try again'}</Button>
      </div>
    );
  }
  if (items.length === 0) {
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
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <article key={item.id} className="flex gap-3 rounded-lg border bg-card p-3">
          <button className="h-20 w-20 shrink-0 overflow-hidden rounded-md border bg-white dark:bg-muted" onClick={() => navigate({ name: 'product', slug: item.slug })}>
            {item.image ? (
               
              <img src={sizedImage(item.image, 160)} alt={item.name} className="h-full w-full object-cover" />
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
                  // Sizes are chosen on the product page (the cart needs one).
                  if (item.hasVariants) {
                    navigate({ name: 'product', slug: item.slug });
                    return;
                  }
                  try {
                    const res = await fetch('/api/cart', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ productId: item.productId, quantity: 1 }),
                    });
                    if (res.ok) {
                      toast({ title: 'Added to cart', description: item.name });
                      queryClient.invalidateQueries({ queryKey: ['cart'] });
                    } else {
                      const err = (await res.json().catch(() => ({}))) as { error?: string };
                      toast({ title: 'Cart', description: err.error ?? 'Could not add to cart.', variant: 'destructive' });
                    }
                  } catch {
                    toast({ title: 'Cart', description: 'No connection — check your internet and try again.', variant: 'destructive' });
                  }
                }}
                disabled={item.stock + (item.variantStock ?? 0) <= 0}
              >
                {item.stock + (item.variantStock ?? 0) <= 0 ? 'Sold out' : item.hasVariants ? 'Choose size' : 'Move to cart'}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={() => remove.mutate(item.productId)}>
                Remove
              </Button>
            </div>
          </div>
        </article>
      ))}
      </div>
      {hasNextPage && (
        <Button
          variant="outline"
          className="w-full"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          {isFetchingNextPage ? 'Loading…' : `Load more saved items${data?.pages[0]?.total ? ` (${data.pages[0].total} total)` : ''}`}
        </Button>
      )}
    </div>
  );
}

/**
 * The Courier Guy tracking block for a paid order: the tracking reference
 * once the marketplace has booked the collection, the courier's own live
 * status, and the scan events. Booking failures show honestly with the
 * reason (e.g. the courier wallet needs a top-up) — tracking never lies.
 */
function CourierTracking({ orderId, paid }: { orderId: string; paid: boolean }) {
  const { data, isLoading } = useQuery<{
    courierStatus?: string | null;
    courierBookedAt?: string | null;
    trackingRef?: string | null;
    courierLiveStatus?: string | null;
    events: { at: string | null; status: string; description: string }[];
    trackingError?: string | null;
  }>({
    queryKey: ['courier', orderId],
    enabled: paid,
    refetchInterval: 60_000,
    queryFn: async () => {
      const res = await fetch(`/api/orders/${orderId}/courier`);
      if (!res.ok) throw new Error('not found');
      return readJson(res);
    },
  });

  if (!paid || isLoading) return null;
  if (!data) return null;

  const failed = typeof data.courierStatus === 'string' && data.courierStatus.startsWith('booking_failed');
  const reason = failed ? data.courierStatus!.slice('booking_failed: '.length) : null;

  if (!data.trackingRef && !failed) return null;

  return (
    <div className="mt-3 rounded-lg border bg-muted/40 p-3" data-testid="courier-tracking">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <Truck className="h-3.5 w-3.5 text-primary" aria-hidden />
        The Courier Guy
      </p>
      {data.trackingRef ? (
        <>
          <p className="mt-1 text-xs text-muted-foreground">
            Tracking reference <span className="font-mono font-semibold text-foreground">{data.trackingRef}</span>
            {data.courierLiveStatus ? <> · {data.courierLiveStatus.replace(/_/g, ' ')}</> : null}
          </p>
          {data.events.length > 0 && (
            <ol className="mt-2 space-y-1.5" aria-label="Courier scan history">
              {data.events.slice(0, 8).map((ev, i) => (
                <li key={`${ev.at ?? ''}-${i}`} className="text-xs">
                  <span className="font-medium">{ev.description || ev.status}</span>
                  {ev.at && <span className="text-muted-foreground"> · {formatDateTime(ev.at)}</span>}
                </li>
              ))}
            </ol>
          )}
          {data.trackingError && <p className="mt-1 text-[11px] text-muted-foreground">Live tracking is momentarily unavailable — the reference above is always valid.</p>}
        </>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          The courier collection could not be booked automatically{reason ? `: ${reason}` : ''}. Green Gate is retrying — your order is safe and the seller can also book it from their dashboard.
        </p>
      )}
    </div>
  );
}
