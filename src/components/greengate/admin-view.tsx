'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { ShieldCheck, Users, Store, Package, ScrollText, Activity, Plus, Ban, CheckCircle2, Banknote, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { formatMoney, formatDateTime, ORDER_STATUS_LABELS, type AdminOverview } from '@/lib/types';
import { navigate } from './header';

export function AdminView() {
  const { data: session, status } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newCategory, setNewCategory] = useState('');

  const overview = useQuery<AdminOverview & { auditLogs: { id: string; action: string; target: string | null; detail: string | null; actorEmail: string | null; createdAt: string }[]; applications?: { id: string }[] }>({
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
      const out = await res.json();
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
            <TabsTrigger value="categories">Categories</TabsTrigger>
            <TabsTrigger value="audit"><ScrollText className="mr-1.5 h-4 w-4" /> Audit log</TabsTrigger>
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
                      {order.paymentStatus === 'awaiting_payment' && (
                        <Button size="sm" variant="outline" onClick={() => act.mutate({ action: 'confirm_payment', targetId: order.id })}>
                          <Banknote className="mr-1 h-3.5 w-3.5" /> Confirm
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
