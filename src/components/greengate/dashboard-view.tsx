'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { LayoutDashboard, Package, TrendingUp, Eye, ShoppingCart, AlertTriangle, Banknote, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { formatMoney, formatDateTime, ORDER_STATUS_LABELS, type AnalyticsDto, type OrderDto, type OrderStatus } from '@/lib/types';
import { navigate } from './header';

const RANGES = [
  { value: 'today', label: 'Today' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'This year' },
];

const NEXT_STATUSES: Record<string, OrderStatus[]> = {
  confirmed: ['processing', 'packed', 'shipped', 'cancelled'],
  processing: ['packed', 'ready_for_collection', 'shipped', 'cancelled'],
  packed: ['ready_for_collection', 'shipped'],
  ready_for_collection: ['delivered'],
  shipped: ['in_transit'],
  in_transit: ['out_for_delivery', 'delivered'],
  out_for_delivery: ['delivered'],
};

export function DashboardView() {
  const { data: session, status } = useSession();
  const [range, setRange] = useState('30');

  const mine = useQuery<{ store: { id: string; slug: string; name: string; status: string } | null }>({
    queryKey: ['my-store'],
    queryFn: async () => (await fetch('/api/sellers?mine=1')).json(),
    enabled: Boolean(session),
  });

  if (status === 'loading' || mine.isLoading) {
    return <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-12"><Skeleton className="h-72 w-full" /></main>;
  }

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center gap-4 px-4 py-20 text-center">
        <LayoutDashboard className="h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">Sign in to view your seller dashboard</p>
        <Button onClick={() => navigate({ name: 'signin' })}>Sign in</Button>
      </main>
    );
  }

  if (mine.data && !mine.data.store) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center gap-4 px-4 py-20 text-center">
        <p className="text-sm font-medium">You need a store first</p>
        <p className="text-xs text-muted-foreground">Create your store to start selling and see analytics.</p>
        <Button onClick={() => navigate({ name: 'sell' })}>Create my store</Button>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Seller dashboard</h1>
          <p className="text-sm text-muted-foreground">{mine.data?.store?.name}</p>
        </div>
        <Select value={range} onValueChange={setRange}>
          <SelectTrigger className="w-[160px]" aria-label="Analytics date range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((r) => (
              <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {mine.data?.store?.status === 'pending' && (
        <div className="mt-4 rounded-lg border border-amber-600/30 bg-amber-500/10 p-4">
          <p className="text-sm font-medium">Application under review</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The Green Gate team is reviewing your application. You will be notified here and by email the moment your store is approved — then you can start listing products.
          </p>
        </div>
      )}
      {mine.data?.store?.status === 'declined' && (
        <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <p className="text-sm font-medium">Application declined</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Unfortunately your store application was not approved. Contact support if you believe this is a mistake, or submit a new application with corrected details.
          </p>
        </div>
      )}

      <DashboardAnalytics range={range} />
      <SellerOrders />
    </main>
  );
}

function DashboardAnalytics({ range }: { range: string }) {
  const { data, isLoading, isError } = useQuery<AnalyticsDto>({
    queryKey: ['analytics', range],
    queryFn: async () => {
      const res = await fetch(`/api/seller/analytics?range=${range}`);
      if (!res.ok) throw new Error('failed');
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
      </div>
    );
  }
  if (isError || !data) {
    return <p className="mt-6 rounded-lg border p-6 text-sm text-muted-foreground">Analytics could not be loaded. Please try again shortly.</p>;
  }

  const t = data.totals;
  const hasSales = t.orders > 0;

  return (
    <>
      <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Key metrics">
        <StatCard icon={Banknote} label="Revenue" value={formatMoney(t.revenueCents)} />
        <StatCard icon={ShoppingCart} label="Orders" value={String(t.orders)} />
        <StatCard icon={Package} label="Units sold" value={String(t.units)} sub={`AOV ${formatMoney(t.avgOrderValueCents)}`} />
        <StatCard icon={TrendingUp} label="Conversion" value={t.conversionPct === null ? '—' : `${t.conversionPct}%`} sub={`${t.views} product views`} />
        <StatCard icon={Eye} label="Product views" value={String(t.views)} sub={`${t.addToLists} cart/wishlist adds`} />
        <StatCard icon={Package} label="Live listings" value={String(t.products)} />
        <StatCard icon={AlertTriangle} label="Low stock (≤5)" value={String(t.lowStock)} />
        <StatCard icon={AlertTriangle} label="Out of stock" value={String(t.outOfStock)} />
      </section>

      {!hasSales && (
        <p className="mt-4 rounded-lg border bg-secondary px-4 py-3 text-xs text-muted-foreground">
          No confirmed sales in this period yet — revenue and order charts fill in as buyers complete checkout and payment is confirmed.
        </p>
      )}

      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-bold">Revenue &amp; orders</h2>
          <div className="mt-3 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.daily} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11 }} width={56} tickFormatter={(v) => `R${v}`} />
                <Tooltip formatter={(value: number, name: string) => (name === 'revenue' ? [`R${Number(value).toFixed(2)}`, 'Revenue'] : [value, 'Orders'])} contentStyle={{ borderRadius: 6 }} />
                <Area type="monotone" dataKey="revenue" stroke="var(--chart-1)" fill="url(#rev)" strokeWidth={2} />
                <Area type="monotone" dataKey="orders" stroke="var(--chart-2)" fill="transparent" strokeWidth={1.5} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-bold">Product views vs add-to-cart activity</h2>
          <div className="mt-3 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.daily} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11 }} width={36} allowDecimals={false} />
                <Tooltip contentStyle={{ borderRadius: 6 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="views" name="Views" fill="var(--chart-2)" radius={[2, 2, 0, 0]} />
                <Bar dataKey="units" name="Units sold" fill="var(--chart-1)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-bold">Best sellers (this period)</h2>
          {data.topProducts.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No product sales in this period yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Views</TableHead>
                  <TableHead className="text-right">Units</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topProducts.map((p) => (
                  <TableRow key={p.productId}>
                    <TableCell className="max-w-56 truncate font-medium">{p.name}</TableCell>
                    <TableCell className="text-right">{p.views}</TableCell>
                    <TableCell className="text-right">{p.units}</TableCell>
                    <TableCell className="text-right font-semibold">{formatMoney(Math.round(p.revenue * 100))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <div className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-bold">Revenue by category</h2>
          {data.categories.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No sales to break down yet.</p>
          ) : (
            <div className="mt-3 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={data.categories} dataKey="revenue" nameKey="category" innerRadius={45} outerRadius={80} paddingAngle={2}>
                    {data.categories.map((_, i) => (
                      <Cell key={i} fill={`var(--chart-${(i % 5) + 1})`} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => `R${Number(v).toFixed(2)}`} contentStyle={{ borderRadius: 6 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function StatCard({ icon: Icon, label, value, sub }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
      </div>
      <p className="mt-1 text-xl font-bold">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function SellerOrders() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ orders: (OrderDto & { buyerPhone: string | null; items: { id: string; name: string; variantLabel: string | null; quantity: number; unitPriceCents: number; image: string | null }[] })[] }>({
    queryKey: ['seller-orders'],
    queryFn: async () => {
      const res = await fetch('/api/seller/orders');
      if (!res.ok) throw new Error('failed');
      return res.json();
    },
  });

  const act = useMutation({
    mutationFn: async ({ id, ...body }: { id: string; action: string; status?: string; note?: string }) => {
      const res = await fetch(`/api/seller/orders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? 'Could not update the order');
      return out;
    },
    onSuccess: () => {
      toast({ title: 'Order updated', description: 'The buyer has been notified by email.' });
      queryClient.invalidateQueries({ queryKey: ['seller-orders'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
    },
    onError: (e: Error) => toast({ title: 'Order', description: e.message, variant: 'destructive' }),
  });

  if (isLoading) return <Skeleton className="mt-6 h-48 w-full" />;
  const orders = data?.orders ?? [];

  return (
    <section className="mt-8" aria-label="Store orders">
      <h2 className="flex items-center gap-2 text-lg font-bold"><Package className="h-5 w-5 text-primary" /> Orders</h2>
      {orders.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm font-medium">No orders yet</p>
          <p className="mt-1 text-xs text-muted-foreground">Orders appear here the moment a buyer checks out with your products.</p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {orders.map((order) => (
            <article key={order.id} className="rounded-lg border bg-card">
              <button
                className="flex w-full flex-wrap items-center gap-3 p-4 text-left"
                onClick={() => setOpen(open === order.id ? null : order.id)}
                aria-expanded={open === order.id}
              >
                <div className="flex-1">
                  <p className="font-mono text-sm font-bold text-primary">{order.number}</p>
                  <p className="text-xs text-muted-foreground">{formatDateTime(order.createdAt)} · {order.buyerName}</p>
                </div>
                {order.paymentStatus === 'awaiting_payment' && <Badge variant="destructive">Payment pending</Badge>}
                <Badge variant="secondary">{ORDER_STATUS_LABELS[order.status as keyof typeof ORDER_STATUS_LABELS] ?? order.status}</Badge>
                <span className="text-sm font-bold">{formatMoney(order.totalCents)}</span>
                <ChevronDown className={`h-4 w-4 transition-transform ${open === order.id ? 'rotate-180' : ''}`} />
              </button>

              {open === order.id && (
                <div className="border-t px-4 py-3">
                  <ul className="space-y-1.5 text-sm">
                    {order.items.map((item) => (
                      <li key={item.id} className="flex items-center gap-2">
                        {item.image && (
                           
                          <img src={item.image} alt="" className="h-8 w-8 rounded border object-cover" />
                        )}
                        <span className="flex-1 truncate">{item.quantity} × {item.name}{item.variantLabel ? ` (${item.variantLabel})` : ''}</span>
                        <span>{formatMoney(item.unitPriceCents * item.quantity)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Deliver to: {order.buyerName}, {order.address} · {order.buyerPhone} · {order.buyerEmail}
                  </p>
                  {typeof order.deliveryLat === 'number' && typeof order.deliveryLng === 'number' && (
                    <p className="mt-1 text-xs">
                      <a
                        className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                        href={`https://www.google.com/maps?q=${order.deliveryLat},${order.deliveryLng}`}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        📍 Exact courier pin ({order.deliveryLat.toFixed(5)}, {order.deliveryLng.toFixed(5)}){order.deliveryAccuracyMeters ? ` · ±${order.deliveryAccuracyMeters} m` : ''} — open map
                      </a>
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {order.paymentStatus === 'awaiting_payment' && (
                      <Button
                        size="sm"
                        onClick={() => act.mutate({ id: order.id, action: 'confirm_payment', note: 'EFT received' })}
                        disabled={act.isPending}
                      >
                        <Banknote className="h-4 w-4" /> Confirm payment received
                      </Button>
                    )}
                    {(NEXT_STATUSES[order.status] ?? []).map((next) => (
                      <Button
                        key={next}
                        size="sm"
                        variant="outline"
                        onClick={() => act.mutate({ id: order.id, action: 'status', status: next })}
                        disabled={act.isPending}
                      >
                        Mark {ORDER_STATUS_LABELS[next].toLowerCase()}
                      </Button>
                    ))}
                  </div>
                  {order.status === 'pending_payment' && (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Confirm payment once the EFT reflects in your account — this moves the order into fulfilment and notifies the buyer.
                    </p>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
