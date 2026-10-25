'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { ShieldCheck, Users, Store, Package, ScrollText, Activity, Plus, Ban, CheckCircle2, Banknote, Clock, Trash2, Search, BarChart3, KeyRound, CreditCard, TrendingUp, Gauge, Wallet, Landmark, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { formatMoney, formatDateTime, ORDER_STATUS_LABELS, PAYMENT_PROVIDER_LABELS, type AdminOverview } from '@/lib/types';
import { navigate } from './header';
import { readJson } from '@/lib/utils';

export function AdminView() {
  const { data: session, status } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newCategory, setNewCategory] = useState('');

  const overview = useQuery<AdminOverview & { auditLogs: { id: string; action: string; target: string | null; detail: string | null; actorEmail: string | null; createdAt: string }[]; applications?: { id: string }[]; insights?: Insights }>({
    queryKey: ['admin'],
    queryFn: async () => {
      const res = await fetch('/api/admin');
      if (!res.ok) throw new Error('forbidden');
      return res.json();
    },
    enabled: Boolean(session),
  });

  const act = useMutation({
    mutationFn: async (body: { action: string; targetId?: string; value?: string; note?: string }) => {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await readJson(res);
      if (!res.ok) throw new Error(out.error ?? 'Action failed');
      return out;
    },
    onSuccess: () => {
      toast({ title: 'Done' });
      queryClient.invalidateQueries({ queryKey: ['admin'] });
      queryClient.invalidateQueries({ queryKey: ['categories'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (e: Error) => toast({ title: 'Action failed', description: e.message, variant: 'destructive' }),
  });

  if (status === 'loading') return <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-12"><Skeleton className="h-72 w-full" /></main>;

  if (!session || (overview.error as Error | null)?.message === 'forbidden') {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center gap-4 px-4 py-20 text-center">
        <ShieldCheck className="h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">Administrator access only</p>
        <p className="text-xs text-muted-foreground">
          This console is restricted to marketplace administrators. Permissions are verified server-side on every request.
        </p>
        <Button variant="outline" onClick={() => navigate({ name: 'store' })}>Back to marketplace</Button>
      </main>
    );
  }

  const o = overview.data;

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
      <h1 className="flex items-center gap-2 text-2xl font-bold"><ShieldCheck className="h-6 w-6 text-primary" /> Admin console</h1>
      <p className="text-sm text-muted-foreground">Marketplace oversight — every action here is audited.</p>

      {!o ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : (
        <Tabs defaultValue="overview" className="mt-4">
          <TabsList className="flex-wrap">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="stores"><Store className="mr-1.5 h-4 w-4" /> Stores</TabsTrigger>
            <TabsTrigger value="orders">Orders</TabsTrigger>
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="insights"><BarChart3 className="mr-1.5 h-4 w-4" /> Insights</TabsTrigger>
            <TabsTrigger value="categories">Categories</TabsTrigger>
            <TabsTrigger value="audit"><ScrollText className="mr-1.5 h-4 w-4" /> Audit log</TabsTrigger>
            <TabsTrigger value="monitor"><Gauge className="mr-1.5 h-4 w-4" /> Monitor</TabsTrigger>
            <TabsTrigger value="health"><Activity className="mr-1.5 h-4 w-4" /> System health</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat icon={Users} label="Registered users" value={String(o.users.total)} sub={`${o.users.sellers} sellers · ${o.users.buyers} buyers`} />
              <Stat icon={Store} label="Active stores" value={String(o.stores.filter((s) => s.status === 'active').length)} />
              <Stat icon={Clock} label="Applications waiting" value={String(o.applications?.length ?? 0)} sub="Seller applications under review" />
              <Stat icon={Package} label="Products" value={String(o.products.total)} sub={`${o.products.approved} approved · ${o.products.disabled} disabled`} />
              <Stat icon={Banknote} label="Confirmed sales" value={String(o.orders.sales)} sub={`${formatMoney(o.orders.revenueCents)} lifetime`} />
              <Stat icon={Package} label="Orders total" value={String(o.orders.total)} sub={`${o.orders.pendingPayment} awaiting payment`} />
              <Stat icon={Users} label="Categories" value={String(o.categories.length)} />
            </div>
            <h2 className="mt-6 text-sm font-bold">Newest accounts</h2>
            <Table className="mt-2">
              <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Name</TableHead><TableHead>Role</TableHead><TableHead>Joined</TableHead></TableRow></TableHeader>
              <TableBody>
                {o.users.recent.map((u) => (
                  <TableRow key={u.email}>
                    <TableCell>{u.email}</TableCell>
                    <TableCell>{u.name ?? '—'}</TableCell>
                    <TableCell><Badge variant="secondary">{u.role}</Badge></TableCell>
                    <TableCell>{formatDateTime(u.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>

          <TabsContent value="stores" className="mt-4">
            {o.stores.length === 0 ? (
              <p className="rounded-lg border p-8 text-center text-sm text-muted-foreground">No stores registered yet.</p>
            ) : (
              <Table>
                <TableHeader><TableRow><TableHead>Store</TableHead><TableHead>Owner</TableHead><TableHead>Products</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
                <TableBody>
                  {o.stores.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.name}</TableCell>
                      <TableCell className="text-xs">{s.email}</TableCell>
                      <TableCell>{s.productCount}</TableCell>
                      <TableCell><Badge variant={s.status === 'active' ? 'secondary' : s.status === 'pending' ? 'outline' : 'destructive'}>{s.status}</Badge></TableCell>
                      <TableCell className="text-right">
                        {s.status === 'pending' ? (
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              onClick={() => act.mutate({ action: 'store_status', targetId: s.id, value: 'active' })}
                            >
                              <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Accept
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => act.mutate({ action: 'store_status', targetId: s.id, value: 'declined' })}
                            >
                              <Ban className="mr-1 h-3.5 w-3.5" /> Decline
                            </Button>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant={s.status === 'active' ? 'outline' : 'default'}
                            onClick={() => act.mutate({ action: 'store_status', targetId: s.id, value: s.status === 'active' ? 'suspended' : 'active' })}
                          >
                            {s.status === 'active' ? <><Ban className="mr-1 h-3.5 w-3.5" /> Suspend</> : <><CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Reactivate</>}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          <TabsContent value="orders" className="mt-4">
            <Table>
              <TableHeader><TableRow><TableHead>Order</TableHead><TableHead>Store</TableHead><TableHead>Status</TableHead><TableHead>Payment</TableHead><TableHead>Total</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader>
              <TableBody>
                {o.orders.recent.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-mono text-xs font-bold text-primary">{order.number}</TableCell>
                    <TableCell className="text-xs">{order.store?.name}</TableCell>
                    <TableCell>{ORDER_STATUS_LABELS[order.status as keyof typeof ORDER_STATUS_LABELS] ?? order.status}</TableCell>
                    <TableCell className="text-xs">{order.paymentStatus.replace('_', ' ')}</TableCell>
                    <TableCell className="font-semibold">{formatMoney(order.totalCents)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {order.paymentStatus === 'awaiting_payment' && (
                          <Button size="sm" variant="outline" onClick={() => act.mutate({ action: 'confirm_payment', targetId: order.id })}>
                            <Banknote className="mr-1 h-3.5 w-3.5" /> Confirm
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          disabled={act.isPending}
                          onClick={() => {
                            if (window.confirm(`Permanently delete order ${order.number}? This removes the order, its items and its event trail. Only delete test or junk records — real customer orders should be kept.`)) {
                              act.mutate({ action: 'delete_order', targetId: order.id });
                            }
                          }}
                        >
                          <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>

          <TabsContent value="users" className="mt-4">
            <Table>
              <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Name</TableHead><TableHead>Role</TableHead><TableHead>Phone</TableHead><TableHead>Joined</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {o.users.recent.map((u) => (
                  <TableRow key={u.id ?? u.email}>
                    <TableCell className="font-medium">
                      {u.email}
                      {u.banned && <Badge variant="destructive" className="ml-2">banned</Badge>}
                    </TableCell>
                    <TableCell>{u.name ?? '—'}</TableCell>
                    <TableCell><Badge variant="secondary">{u.role}</Badge></TableCell>
                    <TableCell className="text-xs">{u.phone ?? '—'}</TableCell>
                    <TableCell className="text-xs">{formatDateTime(u.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      {u.role === 'ADMIN' ? (
                        <span className="text-xs text-muted-foreground">Protected</span>
                      ) : (
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={act.isPending || !u.id}
                            onClick={() => {
                              if (!u.id) return;
                              const ban = !u.banned;
                              if (window.confirm(ban
                                ? `Ban ${u.email}? They lose access immediately and their store is suspended — but the account and its data are kept and can be restored at any time.`
                                : `Unban ${u.email}? Their suspended store(s) will be restored.`)) {
                                act.mutate({ action: 'user_ban', targetId: u.id, value: String(ban) });
                              }
                            }}
                          >
                            {u.banned ? <><CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Unban</> : <><Ban className="mr-1 h-3.5 w-3.5" /> Ban</>}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={act.isPending || !u.id}
                            onClick={() => {
                              if (!u.id) return;
                              if (window.confirm(`Permanently delete ${u.email}? This removes the account with ALL its stores, products and orders. This cannot be undone. To block access without deleting, use Ban instead.`)) {
                                act.mutate({ action: 'delete_user', targetId: u.id });
                              }
                            }}
                          >
                            <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-3 text-xs text-muted-foreground">Showing the 100 newest accounts. Ban blocks access without deleting anything; Delete is permanent and audited. Administrators cannot be banned or deleted.</p>
          </TabsContent>

          <TabsContent value="insights" className="mt-4">
            <InsightsPanel insights={o.insights} />
          </TabsContent>

          <TabsContent value="categories" className="mt-4">
            <form
              className="flex max-w-md gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (newCategory.trim().length >= 2) {
                  act.mutate({ action: 'create_category', value: newCategory.trim() });
                  setNewCategory('');
                }
              }}
            >
              <Input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="New category name" aria-label="New category name" />
              <Button type="submit" size="sm"><Plus className="mr-1 h-4 w-4" /> Add</Button>
            </form>
            <div className="mt-4 flex flex-wrap gap-2">
              {o.categories.map((c) => (
                <Badge key={c.slug} variant="outline">{c.name}</Badge>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Categories are database-driven — new ones appear in the shop navigation immediately.</p>
          </TabsContent>

          <TabsContent value="audit" className="mt-4">
            <div className="max-h-96 overflow-y-auto rounded-lg border">
              <Table>
                <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Actor</TableHead><TableHead>Action</TableHead><TableHead>Target</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
                <TableBody>
                  {o.auditLogs.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="whitespace-nowrap text-xs">{formatDateTime(a.createdAt)}</TableCell>
                      <TableCell className="text-xs">{a.actorEmail ?? '—'}</TableCell>
                      <TableCell><Badge variant="secondary" className="text-[10px]">{a.action}</Badge></TableCell>
                      <TableCell className="max-w-40 truncate text-xs">{a.target ?? '—'}</TableCell>
                      <TableCell className="max-w-56 truncate text-xs text-muted-foreground">{a.detail ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="monitor" className="mt-4">
            <MonitorPanel />
          </TabsContent>

          <TabsContent value="health" className="mt-4">
            <HealthPanel />
          </TabsContent>
        </Tabs>
      )}
    </main>
  );
}

function Stat({ icon: Icon, label, value, sub }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="h-3.5 w-3.5" aria-hidden /> {label}</div>
      <p className="mt-1 text-xl font-bold">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function HealthPanel() {
  const { data, isLoading, isError, refetch } = useQuery<{ status: string; checks: { service: string; ok: boolean; detail: string }[]; time: string }>({
    queryKey: ['health'],
    queryFn: async () => (await fetch('/api/health')).json(),
    refetchInterval: 60_000,
  });

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (isError || !data) return <p className="text-sm text-muted-foreground">Health data unavailable.</p>;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold">
          Overall: <Badge variant={data.status === 'ok' ? 'secondary' : 'destructive'}>{data.status}</Badge>
        </p>
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>Refresh</Button>
      </div>
      <ul className="mt-3 space-y-2">
        {data.checks.map((c) => (
          <li key={c.service} className="flex items-center gap-2 text-sm">
            <span className={`h-2 w-2 rounded-sm ${c.ok ? 'bg-primary' : 'bg-destructive'}`} aria-hidden />
            <span className="font-medium">{c.service}</span>
            <span className="text-xs text-muted-foreground">{c.detail}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-muted-foreground">Checked {formatDateTime(data.time)} · secrets are never included in health output.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Insights — what shoppers search, which features they use, and how much of
// each paid API the marketplace consumes (with where to manage billing).
// Every number is computed from real database rows.
// ---------------------------------------------------------------------------

interface Insights {
  windowDays: number;
  searchTotal: number;
  topSearches: { term: string; count: number }[];
  emptySearches: { term: string; count: number }[];
  featureUsage: { type: string; count: number }[];
  apiUsage: { service: string; calls: number }[];
  services?: Record<string, boolean>;
}

const FEATURE_LABELS: Record<string, string> = {
  view: 'Product views',
  cart: 'Add to cart',
  wishlist: 'Wishlist saves',
  purchase: 'Purchases',
  rec_click: 'Recommendation clicks',
  published: 'Products published',
};

const SERVICE_META: Record<string, { label: string; manage: string; manageLabel: string; cost: string }> = {
  resend: {
    label: 'Resend — transactional email (order confirmations, verification, password resets)',
    manage: 'https://dashboard.resend.com/billing',
    manageLabel: 'Resend billing',
    cost: 'Free tier: 3,000 emails/month (100/day). Paid plans from ~$20/month once you outgrow it. Pay by card in the Resend dashboard.',
  },
  courier_guy: {
    label: 'The Courier Guy — live shipping rates & labels',
    manage: 'https://thecourierguy.co.za/',
    manageLabel: 'Courier Guy account',
    cost: 'Quotes are free; you pay per shipment at your account rates. Top up / settle in your Courier Guy portal.',
  },
  geocode: {
    label: 'Address search & geocoding (Nominatim + Photon)',
    manage: 'https://operations.osmfoundation.org/policies/nominatim/',
    manageLabel: 'Usage policy',
    cost: 'Free public endpoints — no payment required. If traffic ever outgrows fair-use limits, switch to Google Maps Platform (pay-as-you-go, card required).',
  },
  algolia: {
    label: 'Algolia — instant typo-tolerant search (optional)',
    manage: 'https://dashboard.algolia.com/account/billing',
    manageLabel: 'Algolia billing',
    cost: 'Free tier: 10,000 searches/month. Paid from ~$49/month. Optional — the database search fallback works without it.',
  },
};

function InsightsPanel({ insights }: { insights?: Insights }) {
  if (!insights) {
    return <p className="text-sm text-muted-foreground">Insights will appear once the marketplace has activity.</p>;
  }
  const maxFeature = Math.max(1, ...insights.featureUsage.map((f) => f.count));
  const maxSearch = Math.max(1, ...insights.topSearches.map((t) => t.count));

  return (
    <div className="space-y-6">
      <section>
        <h2 className="flex items-center gap-2 text-sm font-bold"><Search className="h-4 w-4" /> What shoppers search for <span className="font-normal text-muted-foreground">(last {insights.windowDays} days · {insights.searchTotal} searches)</span></h2>
        {insights.topSearches.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No searches yet — this fills in as shoppers use the search bar.</p>
        ) : (
          <div className="mt-3 grid gap-6 lg:grid-cols-2">
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs font-semibold text-muted-foreground">Top searches</p>
              <ul className="mt-2 space-y-2">
                {insights.topSearches.map((t) => (
                  <li key={t.term} className="text-sm">
                    <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{t.term}</span><span className="shrink-0 text-xs text-muted-foreground">{t.count}</span></div>
                    <div className="mt-1 h-1.5 rounded-full bg-muted"><div className="h-1.5 rounded-full bg-primary" style={{ width: `${Math.max(4, Math.round((t.count / maxSearch) * 100))}%` }} /></div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs font-semibold text-muted-foreground">Zero-result searches — real demand you cannot fulfil yet</p>
              {insights.emptySearches.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">Every search returned results. Nothing missing.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {insights.emptySearches.map((t) => (
                    <li key={t.term} className="flex items-center justify-between gap-2 text-sm"><span className="truncate font-medium">{t.term}</span><Badge variant="outline">{t.count}× not found</Badge></li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground">Tip: recruit sellers (or add stock) for these exact terms — they are shoppers you are losing today.</p>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2 className="flex items-center gap-2 text-sm font-bold"><TrendingUp className="h-4 w-4" /> Feature usage <span className="font-normal text-muted-foreground">(real behaviour events, last {insights.windowDays} days)</span></h2>
        {insights.featureUsage.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No feature activity yet.</p>
        ) : (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {insights.featureUsage.map((f) => (
              <li key={f.type} className="rounded-lg border bg-card p-4">
                <p className="text-xs text-muted-foreground">{FEATURE_LABELS[f.type] ?? f.type}</p>
                <p className="mt-1 text-xl font-bold">{f.count}</p>
                <div className="mt-2 h-1.5 rounded-full bg-muted"><div className="h-1.5 rounded-full bg-primary" style={{ width: `${Math.max(4, Math.round((f.count / maxFeature) * 100))}%` }} /></div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="flex items-center gap-2 text-sm font-bold"><KeyRound className="h-4 w-4" /> API key usage & billing <span className="font-normal text-muted-foreground">(actual outbound calls, last {insights.windowDays} days)</span></h2>
        <div className="mt-3 space-y-3">
          {Object.entries(SERVICE_META).map(([key, meta]) => {
            const usage = insights.apiUsage.find((a) => a.service === key);
            const configured = insights.services?.[key] ?? false;
            return (
              <div key={key} className="rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{meta.label}</p>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold">{usage ? usage.calls.toLocaleString() : '0'}</span>
                    <span className="text-xs text-muted-foreground">calls</span>
                    <Badge variant={configured ? 'secondary' : 'outline'}>{configured ? 'active' : 'not configured'}</Badge>
                  </div>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">{meta.cost}</p>
                <a href={meta.manage} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs font-medium text-primary underline-offset-2 hover:underline">Manage / pay at {meta.manageLabel} ↗</a>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="flex items-center gap-2 text-sm font-bold"><CreditCard className="h-4 w-4" /> Payment processors</h2>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm font-semibold">Marketplace-wide card payments (PayFast — already integrated)</p>
            <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-xs text-muted-foreground">
              <li>Create a PayFast account (payfast.io) and complete their merchant verification.</li>
              <li>Set PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY and PAYFAST_PASSPHRASE as Vercel environment variables (set PAYFAST_SANDBOX=1 first to test safely).</li>
              <li>That's it — buyers instantly get a “Pay with PayFast” button (card, instant EFT) on unpaid orders; PayFast notifies the server, which verifies the signature and confirms the order automatically.</li>
              <li>Ozow instant EFT and seller-owned Yoco cards run on the same verified in-app payment layer — sellers connect their own accounts in Seller dashboard → Payment details.</li>
            </ol>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm font-semibold">Seller-level (each store's own processor)</p>
            <p className="mt-2 text-xs text-muted-foreground">Sellers set their own processor in <span className="font-medium text-foreground">Seller dashboard → Payment details</span> — PayFast (card / instant EFT), Ozow instant EFT, Yoco cards (Mastercard &amp; Visa), their own hosted payment-page link, or bank transfer to their account. Each choice links straight to the platform so the seller can create their account, and keys are encrypted at rest — never returned by any API. Buyers pay on the provider's secure page and verified webhooks confirm the order automatically (live keys only — test keys are refused on the live site); legacy link-based processors keep working via the one-click <span className="font-medium text-foreground">Pay online</span> button.</p>
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// In-app monitor — a live operations snapshot for the administrator: service
// reachability with database latency, how sellers configure their own payment
// processors, and the work queues that need attention. Read-only, admin-gated,
// and refreshed automatically; it never exposes a credential value.
// ---------------------------------------------------------------------------

interface MonitorReport {
  status: 'ok' | 'degraded';
  time: string;
  latencyMs: number;
  checks: { service: string; ok: boolean; detail: string }[];
  adoption: { provider: string; label: string; stores: number; withLink: number }[];
  payments?: {
    paid: number; failed: number; successRatePct: number | null; volumeCents: number;
    byProvider: { provider: string; count: number }[];
  };
  payouts?: {
    pending: { count: number; netCents: number };
    processing: { count: number; netCents: number };
    paid: { count: number; netCents: number };
    feePercent: number;
  };
  queue: { pendingStores: number; pendingProducts: number; awaitingPayment: number };
  paymentEngine?: { ggpayMode: 'test' | 'live' };
  totals: { users: number; sellers: number; activeStores: number; liveProducts: number; orders: number; banned: number };
}

function MonitorPanel() {
  const { data, isLoading, isError, refetch, isRefetching } = useQuery<MonitorReport>({
    queryKey: ['monitor'],
    queryFn: async () => {
      const res = await fetch('/api/monitor');
      if (!res.ok) throw new Error('unavailable');
      return res.json();
    },
    refetchInterval: 30_000,
  });

  if (isLoading) return <Skeleton className="h-72 w-full" />;
  if (isError || !data) return <p className="text-sm text-muted-foreground">Monitor data unavailable. Try the refresh button shortly.</p>;

  const maxStores = Math.max(1, ...data.adoption.map((a) => a.stores));

  return (
    <div className="space-y-6" aria-label="In-app monitor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-bold">
          Overall: <Badge variant={data.status === 'ok' ? 'secondary' : 'destructive'}>{data.status}</Badge>
          <span className="font-normal text-muted-foreground">· database responded in {data.latencyMs} ms</span>
        </p>
        <Button variant="ghost" size="sm" onClick={() => void refetch()} disabled={isRefetching}>
          {isRefetching ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <section aria-label="Service status">
        <h2 className="text-sm font-bold">Service status <span className="font-normal text-muted-foreground">(auto-refreshes every 30 s)</span></h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {data.checks.map((c) => (
            <li key={c.service} className="flex items-start gap-2 rounded-lg border bg-card p-3 text-sm">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${c.ok ? 'bg-primary' : 'bg-destructive'}`} aria-hidden />
              <div>
                <p className="font-medium">{c.service}</p>
                <p className="text-xs text-muted-foreground">{c.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Payment processor adoption">
        <h2 className="flex items-center gap-2 text-sm font-bold"><CreditCard className="h-4 w-4" /> How sellers take payment <span className="font-normal text-muted-foreground">(active stores by processor)</span></h2>
        {data.adoption.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No active stores yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {data.adoption.map((a) => (
              <li key={a.provider} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{a.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {a.stores} store{a.stores === 1 ? '' : 's'} · {a.withLink} payment link{a.withLink === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-muted"><div className="h-1.5 rounded-full bg-primary" style={{ width: `${Math.max(4, Math.round((a.stores / maxStores) * 100))}%` }} /></div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">A processor without a payment link means the seller still needs to paste their hosted payment-page URL in Seller dashboard → Payment details.</p>
      </section>

      {data.payments && data.payouts && (
        <section aria-label="In-app payments and payouts">
          <h2 className="flex items-center gap-2 text-sm font-bold"><Banknote className="h-4 w-4" /> In-app payments (GGPay) <span className="font-normal text-muted-foreground">— in-app card engine status</span></h2>
          {data.paymentEngine && (
            <p className={`mt-2 rounded-md border px-3 py-2 text-xs ${data.paymentEngine.ggpayMode === 'live' ? 'border-primary/30 bg-primary/5 text-primary' : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'}`} role="status">
              {data.paymentEngine.ggpayMode === 'live'
                ? 'GGPay in-app card engine: an acquirer key is set, but no acquirer is connected yet — every card is refused, so no buyer can “pay” without money moving. Buyers pay with the sellers’ own PayFast / Ozow / Yoco accounts or by EFT (real money).'
                : 'GGPay in-app card payments are OFF on the live site — the card form is hidden and every card is refused (sandbox test cards only work in local development). Buyers pay with the sellers’ own PayFast / Ozow / Yoco accounts or by EFT (real money).'}
            </p>
          )}
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat icon={Banknote} label="Card payments settled" value={String(data.payments.paid)} sub={`${formatMoney(data.payments.volumeCents)} total volume`} />
            <Stat icon={AlertTriangle} label="Declined attempts" value={String(data.payments.failed)} sub={data.payments.successRatePct !== null ? `${data.payments.successRatePct}% approval rate` : 'no attempts yet'} />
            <Stat icon={Wallet} label="Payouts awaiting transfer" value={String(data.payouts.pending.count + data.payouts.processing.count)} sub={`${formatMoney(data.payouts.pending.netCents + data.payouts.processing.netCents)} owed to sellers`} />
            <Stat icon={Landmark} label="Payouts completed" value={String(data.payouts.paid.count)} sub={`${formatMoney(data.payouts.paid.netCents)} paid out · fee ${data.payouts.feePercent}%`} />
          </div>
          {/* Scale bar — payments by provider, proportional like a graph scale */}
          <div className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Settled volume by processor</p>
            {data.payments.byProvider.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">No in-app card payments settled yet — every checkout offers card payment by default.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {(() => {
                  const maxCount = Math.max(...data.payments!.byProvider.map((p) => p.count), 1);
                  return data.payments!.byProvider.map((p) => (
                    <li key={p.provider} className="text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{p.provider === 'ggpay_card' ? 'GGPay card (in-app)' : p.provider}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{p.count} payment{p.count === 1 ? '' : 's'}</span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-muted"><div className="h-1.5 rounded-full bg-primary" style={{ width: `${Math.max(4, Math.round((p.count / maxCount) * 100))}%` }} /></div>
                    </li>
                  ));
                })()}
              </ul>
            )}
          </div>
          {/* Payout pipeline scale — pending → processing → paid */}
          <div className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payout pipeline</p>
            {(() => {
              const stages = [
                { label: 'Pending', count: data.payouts!.pending.count, cents: data.payouts!.pending.netCents, cls: 'bg-amber-500' },
                { label: 'Processing', count: data.payouts!.processing.count, cents: data.payouts!.processing.netCents, cls: 'bg-primary/60' },
                { label: 'Paid', count: data.payouts!.paid.count, cents: data.payouts!.paid.netCents, cls: 'bg-primary' },
              ];
              const maxNet = Math.max(...stages.map((s) => s.cents), 1);
              return (
                <ul className="mt-2 space-y-2">
                  {stages.map((s) => (
                    <li key={s.label} className="text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{s.label}</span>
                        <span className="text-xs text-muted-foreground">{s.count} · {formatMoney(s.cents)}</span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-muted"><div className={`h-1.5 rounded-full ${s.cls}`} style={{ width: `${Math.max(4, Math.round((s.cents / maxNet) * 100))}%` }} /></div>
                    </li>
                  ))}
                </ul>
              );
            })()}
          </div>
        </section>
      )}

      <section aria-label="Operations queues">
        <h2 className="flex items-center gap-2 text-sm font-bold"><Clock className="h-4 w-4" /> Needs attention</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat icon={Store} label="Store applications pending" value={String(data.queue.pendingStores)} sub="approve or decline in Stores" />
          <Stat icon={Package} label="Products awaiting approval" value={String(data.queue.pendingProducts)} sub="review in Stores → listings" />
          <Stat icon={Banknote} label="Orders awaiting payment" value={String(data.queue.awaitingPayment)} sub="waiting on buyer / seller confirm" />
          <Stat icon={Users} label="Banned accounts" value={String(data.totals.banned)} sub="blocked from signing in" />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat icon={Users} label="Total accounts" value={String(data.totals.users)} />
          <Stat icon={Store} label="Active stores" value={String(data.totals.activeStores)} sub={`${data.totals.sellers} seller accounts`} />
          <Stat icon={Package} label="Live listings" value={String(data.totals.liveProducts)} />
          <Stat icon={Banknote} label="Orders all-time" value={String(data.totals.orders)} />
        </div>
      </section>

      <p className="text-[11px] text-muted-foreground">Snapshot taken {formatDateTime(data.time)} · secrets are never included in monitor output.</p>
    </div>
  );
}
