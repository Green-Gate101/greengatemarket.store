'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ProductImage } from './product-image';
import { formatZAR, formatDateTime } from '@/lib/format';
import type { AnalyticsDto, SellerDto } from '@/lib/types';
import {
  ArrowRight,
  BarChart3,
  Boxes,
  CircleDollarSign,
  LayoutDashboard,
  Package,
  PackageOpen,
  ShoppingCart,
  TrendingUp,
  TriangleAlert,
} from 'lucide-react';

const CHART_COLOR = '#059669';

async function fetchAnalytics(sellerEmail: string): Promise<AnalyticsDto & { allTimeOrders: number }> {
  const res = await fetch(`/api/analytics?sellerEmail=${encodeURIComponent(sellerEmail)}`);
  if (!res.ok) throw new Error('Failed to load analytics');
  return res.json();
}

export function DashboardView({
  seller,
  sellers,
  onSelectSeller,
  onGoToSell,
}: {
  seller: SellerDto | null;
  sellers: SellerDto[];
  onSelectSeller: (s: SellerDto) => void;
  onGoToSell: () => void;
}) {
  const sellerEmail = seller?.email ?? '';
  const { data: analytics, isLoading: loading, error } = useQuery({
    queryKey: ['analytics', sellerEmail],
    queryFn: () => fetchAnalytics(sellerEmail),
    enabled: sellerEmail.length > 0,
  });
  const queryError = error instanceof Error ? error.message : null;

  if (!seller) {
    return (
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 sm:px-6">
        <div className="mx-auto mt-16 max-w-md rounded-xl border bg-card p-8 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <LayoutDashboard className="h-6 w-6" aria-hidden />
          </span>
          <h1 className="mt-4 text-xl font-semibold">Open your seller dashboard</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Choose one of the stores below, or create a new seller account.
          </p>
          {sellers.length > 0 && (
            <div className="mt-5">
              <Select onValueChange={(id) => { const s = sellers.find((x) => x.id === id); if (s) onSelectSeller(s); }}>
                <SelectTrigger aria-label="Select your store">
                  <SelectValue placeholder="Select your store…" />
                </SelectTrigger>
                <SelectContent>
                  {sellers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.storeName} — {s.location}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <Button variant="outline" className="mt-4 gap-2" onClick={onGoToSell}>
            Create a new store <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </main>
    );
  }

  const stats = analytics?.totals;

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 sm:px-6">
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Seller dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {seller.storeName} · {seller.location}
          </p>
        </div>
        <div className="w-full sm:w-64">
          <Select value={seller.id} onValueChange={(id) => { const s = sellers.find((x) => x.id === id); if (s) onSelectSeller(s); }}>
            <SelectTrigger aria-label="Switch store">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sellers.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.storeName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {queryError && (
        <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          Could not load your dashboard data. Refresh to try again.
        </p>
      )}

      {loading || !analytics ? (
        <DashboardSkeleton />
      ) : (
        <>
          {/* Stat cards */}
          <section className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4" aria-label="Key metrics">
            <StatCard icon={CircleDollarSign} label="Revenue (14 days)" value={formatZAR(stats?.revenue ?? 0)} tone="primary" />
            <StatCard icon={ShoppingCart} label="Orders (14 days)" value={String(stats?.orders ?? 0)} sub={`${analytics.allTimeOrders} all-time`} />
            <StatCard icon={Boxes} label="Units sold (14 days)" value={String(stats?.units ?? 0)} />
            <StatCard icon={TrendingUp} label="Avg order value" value={formatZAR(stats?.avgOrderValue ?? 0)} />
          </section>

          {/* Charts */}
          <section className="mt-6 grid gap-4 lg:grid-cols-5" aria-label="Sales charts">
            <Card className="lg:col-span-3">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <BarChart3 className="h-4 w-4 text-primary" aria-hidden /> Daily revenue
                </CardTitle>
                <CardDescription>Last 14 days, excluding shipping</CardDescription>
              </CardHeader>
              <CardContent className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={analytics.daily} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                    <defs>
                      <linearGradient id="revGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={CHART_COLOR} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={CHART_COLOR} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `R${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`} width={56} />
                    <Tooltip
                      formatter={(value) => [formatZAR(Number(value)), 'Revenue']}
                      contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 12 }}
                    />
                    <Area type="monotone" dataKey="revenue" stroke={CHART_COLOR} strokeWidth={2} fill="url(#revGradient)" />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShoppingCart className="h-4 w-4 text-primary" aria-hidden /> Orders per day
                </CardTitle>
                <CardDescription>Order volume trend</CardDescription>
              </CardHeader>
              <CardContent className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analytics.daily} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
                    <Tooltip
                      formatter={(value) => [String(value), 'Orders']}
                      contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 12 }}
                    />
                    <Bar dataKey="orders" fill={CHART_COLOR} radius={[4, 4, 0, 0]} maxBarSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </section>

          {/* Top products + categories */}
          <section className="mt-6 grid gap-4 lg:grid-cols-2" aria-label="Best sellers">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Package className="h-4 w-4 text-primary" aria-hidden /> Best sellers
                </CardTitle>
                <CardDescription>By revenue, all time</CardDescription>
              </CardHeader>
              <CardContent>
                {analytics.topProducts.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No sales recorded yet.</p>
                ) : (
                  <ul className="space-y-3">
                    {analytics.topProducts.map((p, i) => {
                      const max = analytics.topProducts[0].revenue || 1;
                      return (
                        <li key={p.productId}>
                          <div className="flex items-center justify-between gap-2 text-sm">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">{i + 1}</span>
                              <span className="truncate font-medium">{p.name}</span>
                            </span>
                            <span className="shrink-0 font-semibold tabular-nums">{formatZAR(p.revenue)}</span>
                          </div>
                          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(6, (p.revenue / max) * 100)}%` }} />
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{p.units} unit{p.units === 1 ? '' : 's'} sold</p>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Boxes className="h-4 w-4 text-primary" aria-hidden /> Revenue by category
                </CardTitle>
                <CardDescription>Where your sales come from</CardDescription>
              </CardHeader>
              <CardContent>
                {analytics.categories.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No sales recorded yet.</p>
                ) : (
                  <ul className="space-y-3">
                    {analytics.categories.map((c) => {
                      const max = analytics.categories[0].revenue || 1;
                      return (
                        <li key={c.category}>
                          <div className="flex items-center justify-between text-sm">
                            <span className="truncate font-medium">{c.category}</span>
                            <span className="shrink-0 font-semibold tabular-nums">{formatZAR(c.revenue)}</span>
                          </div>
                          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-amber-500/70" style={{ width: `${Math.max(6, (c.revenue / max) * 100)}%` }} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="mt-4 grid grid-cols-3 gap-2 border-t pt-4 text-center">
                  <div>
                    <p className="text-xs text-muted-foreground">Products</p>
                    <p className="text-sm font-semibold tabular-nums">{stats?.products ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Low stock</p>
                    <p className="text-sm font-semibold tabular-nums text-amber-600">{stats?.lowStock ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Sold out</p>
                    <p className="text-sm font-semibold tabular-nums text-destructive">{stats?.outOfStock ?? 0}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Recent orders */}
          <section className="mt-6" aria-label="Recent orders">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <PackageOpen className="h-4 w-4 text-primary" aria-hidden /> Recent orders
                </CardTitle>
                <CardDescription>The latest orders across your store</CardDescription>
              </CardHeader>
              <CardContent>
                {analytics.recentOrders.length === 0 ? (
                  <div className="flex flex-col items-center rounded-lg border border-dashed py-10 text-center">
                    <PackageOpen className="h-8 w-8 text-muted-foreground/50" aria-hidden />
                    <p className="mt-2 text-sm font-medium">No orders in the last 14 days</p>
                    <p className="mt-1 text-xs text-muted-foreground">Share your storefront link to start making sales.</p>
                  </div>
                ) : (
                  <div className="max-h-96 overflow-y-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-muted/60 backdrop-blur">
                        <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <th className="px-3 py-2.5 font-medium">Product</th>
                          <th className="px-3 py-2.5 font-medium">Customer</th>
                          <th className="hidden px-3 py-2.5 font-medium md:table-cell">Status</th>
                          <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Date</th>
                          <th className="px-3 py-2.5 text-right font-medium">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.recentOrders.map((o) => {
                          const first = o.items[0];
                          const extra = o.items.length - 1;
                          return (
                            <tr key={o.id} className="border-t">
                              <td className="max-w-[220px] px-3 py-2.5">
                                <span className="flex items-center gap-2">
                                  {first?.product && (
                                    <span className="h-8 w-8 shrink-0 rounded border bg-white p-0.5">
                                      <ProductImage src={first.product.imageData} alt="" className="h-full w-full object-contain" />
                                    </span>
                                  )}
                                  <span className="min-w-0">
                                    <span className="block truncate font-medium">{first?.product?.name ?? 'Product'}</span>
                                    {extra > 0 && <span className="block text-xs text-muted-foreground">+{extra} more item{extra > 1 ? 's' : ''}</span>}
                                  </span>
                                </span>
                              </td>
                              <td className="max-w-[140px] truncate px-3 py-2.5">{o.buyerName}</td>
                              <td className="hidden px-3 py-2.5 md:table-cell">
                                <Badge
                                  variant="outline"
                                  className={
                                    o.status === 'delivered'
                                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                      : o.status === 'shipped'
                                        ? 'border-amber-200 bg-amber-50 text-amber-700'
                                        : 'border-stone-200 bg-stone-50 text-stone-600'
                                  }
                                >
                                  {o.status}
                                </Badge>
                              </td>
                              <td className="hidden whitespace-nowrap px-3 py-2.5 text-muted-foreground sm:table-cell">{formatDateTime(o.createdAt)}</td>
                              <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums">{formatZAR(o.total)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </section>

          {(stats?.lowStock ?? 0) + (stats?.outOfStock ?? 0) > 0 && (
            <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800" role="status">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
              <span>
                <strong>{stats?.lowStock ?? 0}</strong> product{(stats?.lowStock ?? 0) === 1 ? ' is' : 's are'} low on stock and{' '}
                <strong>{stats?.outOfStock ?? 0}</strong> {(stats?.outOfStock ?? 0) === 1 ? 'is' : 'are'} sold out.{' '}
                <button onClick={onGoToSell} className="font-semibold underline underline-offset-2 hover:text-amber-900">
                  Restock in the product manager
                </button>
                .
              </span>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: typeof CircleDollarSign;
  label: string;
  value: string;
  sub?: string;
  tone?: 'primary';
}) {
  return (
    <Card>
      <CardContent className="p-4 sm:p-6">
        <div className="flex items-center gap-2">
          <span className={`flex h-8 w-8 items-center justify-center rounded-md ${tone === 'primary' ? 'bg-primary/10 text-primary' : 'bg-muted text-foreground/70'}`}>
            <Icon className="h-4 w-4" aria-hidden />
          </span>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
        <p className="mt-2.5 text-xl font-semibold tabular-nums sm:text-2xl">{value}</p>
        {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="mt-6 space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="space-y-3 p-4 sm:p-6">
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-6 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardContent className="h-64 p-6">
            <Skeleton className="h-full w-full" />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardContent className="h-64 p-6">
            <Skeleton className="h-full w-full" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
