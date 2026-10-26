'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { LayoutDashboard, Package, TrendingUp, Eye, ShoppingCart, AlertTriangle, Banknote, ChevronDown, CreditCard, Landmark, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { formatMoney, formatDateTime, ORDER_STATUS_LABELS, PAYMENT_PROVIDER_LABELS, type AnalyticsDto, type OrderDto, type OrderStatus } from '@/lib/types';
import { navigate } from './header';
import { ProcessorLogo, CardSchemeLogos } from './payment-logos';
import { ProcessorSetupGuide } from './processor-setup-guide';
import { StoreBrandingCard } from './store-branding-card';
import { readJson } from '@/lib/utils';

/** Processors that confirm payment instantly — the only ones buyers may use. */
const INSTANT_PROCESSORS = ['payfast', 'ozow', 'yoco', 'mastercard'];

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

/**
 * Where each payment processor sends the seller to create their own account.
 * Choosing a processor shows a direct link to the platform — the seller signs
 * up there, then pastes their keys back here. SnapScan/Stripe are
 * intentionally absent (removed at the owner's request); bank transfer runs
 * inside the app and needs no external account.
 */
const PROCESSOR_SIGNUP: Record<string, { label: string; url: string; hint: string }> = {
  payfast: {
    label: 'Create a PayFast account',
    url: 'https://www.payfast.io/signup/',
    hint: 'Opens payfast.io in a new tab — sign up and add your store, then copy the Merchant ID, Merchant Key and passphrase from Settings → Developer Settings into the fields below.',
  },
  ozow: {
    label: 'Create an Ozow account',
    url: 'https://www.ozow.com/',
    hint: 'Opens ozow.com in a new tab — sign up as a merchant, then copy the Site Code, Private Key and API key from your Ozow dashboard into the fields below (all three are needed).',
  },
  yoco: {
    label: 'Create a Yoco account',
    url: 'https://www.yoco.com/za/signup/',
    hint: 'Opens yoco.com in a new tab — sign up, then copy your secret key from the Yoco Business Portal → Sell Online → Payment Gateway into the field below.',
  },
  mastercard: {
    label: 'Create a Yoco account to accept Mastercard & Visa',
    url: 'https://www.yoco.com/za/signup/',
    hint: 'Mastercard and Visa cards are accepted through a Yoco account — sign up with Yoco, then connect your secret key below.',
  },
};

export function DashboardView() {
  const { data: session, status } = useSession();
  const [range, setRange] = useState('30');

  const mine = useQuery<{ store: { id: string; slug: string; name: string; status: string } | null }>({
    queryKey: ['my-store'],
    // A failed load must NOT read as "no store": that showed existing
    // sellers the create-a-store screen whenever one request failed.
    queryFn: async () => {
      const res = await fetch('/api/sellers?mine=1');
      if (!res.ok) throw new Error('Could not load your store');
      return res.json();
    },
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

  if (mine.isError) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center gap-4 px-4 py-20 text-center">
        <p className="text-sm font-medium">We could not load your store right now</p>
        <p className="text-xs text-muted-foreground">Check your connection — your store and listings are safe.</p>
        <Button onClick={() => void mine.refetch()} disabled={mine.isFetching}>{mine.isFetching ? 'Trying again…' : 'Try again'}</Button>
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

      {mine.data?.store && (
        <StoreBrandingCard
          store={{
            name: mine.data.store.name,
            slug: mine.data.store.slug ?? null,
            logoData: (mine.data.store as { logoData?: string | null }).logoData ?? null,
            bannerData: (mine.data.store as { bannerData?: string | null }).bannerData ?? null,
          }}
        />
      )}
      <DashboardAnalytics range={range} />
      <SellerOrders />
      <PaymentDetailsCard
        store={{
          slug: mine.data?.store?.slug ?? null,
          payoutProvider: (mine.data?.store as { payoutProvider?: string | null } | null | undefined)?.payoutProvider ?? null,
          payoutLink: (mine.data?.store as { payoutLink?: string | null } | null | undefined)?.payoutLink ?? null,
          payoutNote: (mine.data?.store as { payoutNote?: string | null } | null | undefined)?.payoutNote ?? null,
          yocoKeySet: Boolean((mine.data?.store as { yocoKeySet?: boolean } | null | undefined)?.yocoKeySet),
          payfastKeySet: Boolean((mine.data?.store as { payfastKeySet?: boolean } | null | undefined)?.payfastKeySet),
          ozowKeySet: Boolean((mine.data?.store as { ozowKeySet?: boolean } | null | undefined)?.ozowKeySet),
          paymentStatus: (mine.data?.store as { paymentStatus?: { payfastReady: boolean; ozowReady: boolean; yocoReady: boolean; eftReady: boolean; available: string[]; warnings: string[] } } | null | undefined)?.paymentStatus,
        }}
      />
      <PayoutsCard
        bank={{
          bankName: (mine.data?.store as { bankName?: string | null } | null | undefined)?.bankName ?? '',
          bankAccountType: (mine.data?.store as { bankAccountType?: string | null } | null | undefined)?.bankAccountType ?? '',
          bankAccountNumber: (mine.data?.store as { bankAccountNumber?: string | null } | null | undefined)?.bankAccountNumber ?? '',
          bankBranchCode: (mine.data?.store as { bankBranchCode?: string | null } | null | undefined)?.bankBranchCode ?? '',
          bankAccountHolder: (mine.data?.store as { bankAccountHolder?: string | null } | null | undefined)?.bankAccountHolder ?? '',
        }}
      />
    </main>
  );
}

/**
 * Seller-level payment processor.
 *
 * IN-SYSTEM CARD PAYMENTS (no link): choosing Yoco — or Mastercard cards via
 * Yoco — lets the seller connect their OWN Yoco account by secret key. The
 * marketplace then builds a real card checkout into every order (Mastercard
 * & Visa accepted on Yoco's secure page) and the order confirms itself once
 * the payment verifies server-side. The key is AES-256-GCM encrypted at rest
 * and never returned by any API.
 * IN-APP PAYFAST + OZOW: choosing PayFast or Ozow lets the seller connect
 * their OWN account (merchant id/key/passphrase or site code/private key).
 * Buyers then pay on the processor's secure page (PayFast card / instant
 * EFT, Ozow instant EFT, Yoco cards) and return to the app — the order confirms
 * automatically on verified webhooks. Secrets are AES-256-GCM encrypted at
 * rest and never returned by any API.
 * OTHER PROCESSORS remain link-based: the seller pastes their hosted
 * payment-page link and buyers get a one-click "Pay online" button.
 */
function PaymentDetailsCard({ store }: { store: { slug?: string | null; payoutProvider: string | null; payoutLink: string | null; payoutNote: string | null; yocoKeySet?: boolean; payfastKeySet?: boolean; ozowKeySet?: boolean; paymentStatus?: { payfastReady: boolean; ozowReady: boolean; yocoReady: boolean; eftReady: boolean; available: string[]; warnings: string[] } } }) {
  // Ready = buyers are really offered it (server truth); *KeySet = only saved.
  const status = store.paymentStatus;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // SnapScan/Stripe were removed at the owner's request — a store still holding
  // one of those legacy values falls back to the link-based "other" option so
  // the dropdown always renders a real choice (their saved link stays intact).
  const [provider, setProvider] = useState(
    store.payoutProvider && INSTANT_PROCESSORS.includes(store.payoutProvider) ? store.payoutProvider : 'payfast',
  );
  const [link, setLink] = useState(store.payoutLink ?? '');
  const [note, setNote] = useState(store.payoutNote ?? '');
  const [yocoKey, setYocoKey] = useState('');
  const [clearYocoKey, setClearYocoKey] = useState(false);
  const [payfastId, setPayfastId] = useState('');
  const [payfastKey, setPayfastKey] = useState('');
  const [payfastPass, setPayfastPass] = useState('');
  const [clearPayfast, setClearPayfast] = useState(false);
  const [ozowSite, setOzowSite] = useState('');
  const [ozowKey, setOzowKey] = useState('');
  const [ozowApiKey, setOzowApiKey] = useState('');
  const [clearOzow, setClearOzow] = useState(false);
  const cardMode = provider === 'yoco' || provider === 'mastercard';
  const payfastMode = provider === 'payfast';
  const ozowMode = provider === 'ozow';
  const signup = PROCESSOR_SIGNUP[provider];

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/sellers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payoutProvider: provider === 'bank_transfer' ? '' : provider,
          payoutLink: link.trim(),
          payoutNote: note.trim(),
          ...(cardMode && clearYocoKey ? { clearYocoKey: true } : {}),
          ...(cardMode && yocoKey.trim() ? { yocoSecretKey: yocoKey.trim() } : {}),
          ...(payfastMode && clearPayfast ? { clearPayfast: true } : {}),
          ...(payfastMode && payfastId.trim() && payfastKey.trim()
            ? { payfastMerchantId: payfastId.trim(), payfastMerchantKey: payfastKey.trim(), ...(payfastPass.trim() ? { payfastPassphrase: payfastPass.trim() } : {}) }
            : payfastMode && payfastPass.trim() ? { payfastPassphrase: payfastPass.trim() } : {}),
          ...(ozowMode && clearOzow ? { clearOzow: true } : {}),
          ...(ozowMode && ozowSite.trim() && ozowKey.trim()
            ? { ozowSiteCode: ozowSite.trim(), ozowPrivateKey: ozowKey.trim(), ...(ozowApiKey.trim() ? { ozowApiKey: ozowApiKey.trim() } : {}) }
            : ozowMode && ozowApiKey.trim() ? { ozowApiKey: ozowApiKey.trim() } : {}),
        }),
      });
      const out = await readJson(res);
      if (!res.ok) throw new Error(out.error ?? 'Could not save');
      return out;
    },
    onSuccess: () => {
      toast({ title: 'Payment details saved', description: 'Check the status at the top of Payment details — only options marked ready are offered to buyers.' });
      setYocoKey('');
      setClearYocoKey(false);
      setPayfastId('');
      setPayfastKey('');
      setPayfastPass('');
      setClearPayfast(false);
      setOzowSite('');
      setOzowKey('');
      setOzowApiKey('');
      setClearOzow(false);
      queryClient.invalidateQueries({ queryKey: ['my-store'] });
    },
    onError: (e: Error) => toast({ title: 'Could not save payment details', description: e.message, variant: 'destructive' }),
  });

  return (
    <section className="mt-8 rounded-lg border bg-card p-4 sm:p-6" aria-labelledby="payment-details-heading">
      <h2 id="payment-details-heading" className="flex items-center gap-2 text-lg font-bold"><CreditCard className="h-5 w-5 text-primary" /> Payment details</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Buyers pay you ONLY through a payment processor you connect: PayFast, Ozow or Yoco, with your own LIVE account. They pay by card or instant EFT on the provider's secure page, the money goes straight to your account, and the order confirms automatically the moment the provider verifies the payment — no waiting. Bank transfers (EFT) and pasted payment links are not offered to buyers. Until a processor is connected, buyers cannot buy from your store.
      </p>
      {status && (
        <div className="mt-3 space-y-2" data-testid="payment-status">
          <p className={`rounded-md border px-3 py-2 text-xs ${status.available.length > 0 ? 'border-primary/30 bg-primary/5 text-primary' : 'border-destructive/40 bg-destructive/10 text-destructive'}`} role="status">
            {status.available.length > 0
              ? <><span className="font-semibold">Buyers can pay you with:</span> {status.available.join(' · ')}</>
              : <span className="font-semibold">Buyers currently have no way to pay you.</span>}
          </p>
          {status.warnings.length > 0 && (
            <ul className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300" role="alert">
              {status.warnings.map((w) => (
                <li key={w} className="flex gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="payout-provider" className="text-xs font-semibold text-muted-foreground">Payment processor</label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger id="payout-provider" className="mt-1 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {/* Owner's rule: buyers pay only through processors that confirm
                  instantly — bank transfer and pasted links are not offered. */}
              {Object.entries(PAYMENT_PROVIDER_LABELS).filter(([value]) => INSTANT_PROCESSORS.includes(value)).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  <span className="flex items-center gap-2">
                    <span aria-hidden="true"><ProcessorLogo provider={value} /></span>
                    <span>{label}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {cardMode && (
            <>
              <p className="mt-1.5 text-[11px] text-muted-foreground">Yoco accepts Mastercard &amp; Visa cards — buyers never leave the checkout flow.</p>
              <CardSchemeLogos size="sm" className="mt-1.5" />
            </>
          )}
          {payfastMode && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">Buyers pay by card or instant EFT on PayFast's secure page, then return to Green Gate. Set a passphrase in PayFast (Settings → Developer Settings) — it is required.</p>
          )}
          {ozowMode && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">Buyers pay from their bank via instant EFT on Ozow's secure page — no card needed. Needs your Ozow site code, private key and API key.</p>
          )}
          {signup && (
            <>
              <span className="mt-2 block">
                <ProcessorLogo provider={provider} size="md" />
              </span>
              <a
                href={signup.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2.5 inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
              >
                {signup.label} ↗
              </a>
              <p className="mt-1.5 text-[11px] text-muted-foreground">{signup.hint}</p>
            </>
          )}
        </div>
        {payfastMode ? (
          <div className="grid gap-3 sm:col-span-2 sm:grid-cols-3">
            <div>
              <label htmlFor="payfast-id" className="text-xs font-semibold text-muted-foreground">Merchant ID</label>
              <Input
                id="payfast-id"
                value={payfastId}
                onChange={(e) => setPayfastId(e.target.value.replace(/\D/g, '').slice(0, 20))}
                placeholder={store.payfastKeySet ? undefined : 'e.g. 10000100'}
                inputMode="numeric"
                autoComplete="off"
                className="mt-1"
              />
            </div>
            <div>
              <label htmlFor="payfast-key" className="text-xs font-semibold text-muted-foreground">Merchant key</label>
              <Input
                id="payfast-key"
                type="password"
                value={payfastKey}
                onChange={(e) => setPayfastKey(e.target.value.trim())}
                placeholder={store.payfastKeySet ? '•••• key saved — type a new key to replace' : 'from Settings → Developer Settings'}
                autoComplete="off"
                className="mt-1"
                maxLength={64}
              />
            </div>
            <div>
              <label htmlFor="payfast-pass" className="text-xs font-semibold text-muted-foreground">Passphrase (required)</label>
              <Input
                id="payfast-pass"
                type="password"
                value={payfastPass}
                onChange={(e) => setPayfastPass(e.target.value.trim())}
                placeholder={store.payfastKeySet ? '•••• saved — type to replace' : 'set in Settings → Developer Settings'}
                autoComplete="off"
                className="mt-1"
                maxLength={64}
              />
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Find all three in PayFast → Settings → Developer Settings. Encrypted before storage and never shown again.{status?.payfastReady ? ' Connected — buyers can pay you with PayFast.' : store.payfastKeySet ? ' Saved, but NOT usable yet — see the warning above (to add only the passphrase, type it here and save).' : ''}
              </p>
              {store.payfastKeySet && (
                <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={clearPayfast} onChange={(e) => setClearPayfast(e.target.checked)} className="h-3.5 w-3.5" />
                  Remove the connected PayFast account
                </label>
              )}
            </div>
          </div>
        ) : ozowMode ? (
          <div className="grid gap-3 sm:col-span-2 sm:grid-cols-3">
            <div>
              <label htmlFor="ozow-site" className="text-xs font-semibold text-muted-foreground">Site code</label>
              <Input
                id="ozow-site"
                value={ozowSite}
                onChange={(e) => setOzowSite(e.target.value.trim())}
                placeholder={store.ozowKeySet ? undefined : 'on your Ozow Site page'}
                autoComplete="off"
                className="mt-1"
                maxLength={64}
              />
            </div>
            <div>
              <label htmlFor="ozow-key" className="text-xs font-semibold text-muted-foreground">Private key</label>
              <Input
                id="ozow-key"
                type="password"
                value={ozowKey}
                onChange={(e) => setOzowKey(e.target.value.trim())}
                placeholder={store.ozowKeySet ? '•••• key saved — type a new key to replace' : 'from Merchants → Merchant Details'}
                autoComplete="off"
                className="mt-1"
                maxLength={128}
              />
            </div>
            <div>
              <label htmlFor="ozow-api" className="text-xs font-semibold text-muted-foreground">API key (required)</label>
              <Input
                id="ozow-api"
                type="password"
                value={ozowApiKey}
                onChange={(e) => setOzowApiKey(e.target.value.trim())}
                placeholder={store.ozowKeySet ? '•••• saved — type to replace' : 'from Merchants → Merchant Details'}
                autoComplete="off"
                className="mt-1"
                maxLength={128}
              />
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Find these in your Ozow merchant dashboard. Encrypted before storage and never shown again.{status?.ozowReady ? ' Connected — buyers can pay you with Ozow.' : store.ozowKeySet ? ' Saved, but NOT usable yet — see the warning above (to add only the API key, type it here and save).' : ''}
              </p>
              {store.ozowKeySet && (
                <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={clearOzow} onChange={(e) => setClearOzow(e.target.checked)} className="h-3.5 w-3.5" />
                  Remove the connected Ozow account
                </label>
              )}
            </div>
          </div>
        ) : !cardMode ? (
          <div>
            <label htmlFor="payout-link" className="text-xs font-semibold text-muted-foreground">Your payment page link (https://…)</label>
            <Input
              id="payout-link"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://pay.yoco.com/your-store"
              inputMode="url"
              className="mt-1"
              maxLength={300}
            />
          </div>
        ) : (
          <div>
            <label htmlFor="yoco-key" className="text-xs font-semibold text-muted-foreground">Yoco LIVE secret key (sk_live_…)</label>
            <Input
              id="yoco-key"
              type="password"
              value={yocoKey}
              onChange={(e) => setYocoKey(e.target.value)}
              placeholder={store.yocoKeySet ? '•••• key saved — type a new key to replace' : 'sk_live_…'}
              autoComplete="off"
              className="mt-1"
              maxLength={120}
            />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Find it in the Yoco Business Portal → Sell Online → Payment Gateway. Encrypted before storage and never shown again.{status?.yocoReady ? ' Connected — buyers can pay you by card with Yoco.' : store.yocoKeySet ? ' A key is saved, but buyers are NOT offered Yoco — see the warning above.' : ''}
            </p>
            {store.yocoKeySet && (
              <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={clearYocoKey} onChange={(e) => setClearYocoKey(e.target.checked)} className="h-3.5 w-3.5" />
                Remove the saved key (revert to link / bank transfer)
              </label>
            )}
          </div>
        )}
        <div className="sm:col-span-2">
          <label htmlFor="payout-note" className="text-xs font-semibold text-muted-foreground">Note for buyers (optional)</label>
          <Input
            id="payout-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Pay with your card — delivery is arranged after payment."
            className="mt-1"
            maxLength={200}
          />
        </div>
      </div>
      <ProcessorSetupGuide provider={provider} storeSlug={store.slug} />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save payment details'}</Button>
        <p className="text-xs text-muted-foreground">Processor secrets are AES-256-GCM encrypted before storage and never returned by any API. Never enter passwords here.</p>
      </div>
    </section>
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

      <section className="mt-4 grid gap-4 lg:grid-cols-[1.5fr_1fr] [&>*]:min-w-0">
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
      const out = await readJson(res);
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

/**
 * PayoutsCard — the seller's side of GGPay (Amazon/Takealot-style payouts).
 *
 * When a buyer pays an order in-app, the marketplace queues a payout for this
 * store automatically: gross earnings (product subtotal) less the marketplace
 * fee, paid to the bank account configured below. Sellers can update their
 * payout bank account here at any time — the same details collected at
 * application, editable without contacting support.
 */
function PayoutsCard({ bank }: { bank: { bankName: string; bankAccountType: string; bankAccountNumber: string; bankBranchCode: string; bankAccountHolder: string } }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    bankName: bank.bankName ?? '',
    bankAccountType: bank.bankAccountType ?? '',
    bankAccountNumber: bank.bankAccountNumber ?? '',
    bankBranchCode: bank.bankBranchCode ?? '',
    bankAccountHolder: bank.bankAccountHolder ?? '',
  });

  const payouts = useQuery<{
    payouts: { id: string; reference: string; orderNumber: string; grossCents: number; feeCents: number; netCents: number; destination: string; status: string; held?: boolean; orderStatus?: string | null; paidAt: string | null; createdAt: string }[];
    summary: { feePercent: number; count: number; grossCents: number; feeCents: number; netCents: number; pending: { count: number; netCents: number }; processing: { count: number; netCents: number }; paid: { count: number; netCents: number }; held?: { count: number; netCents: number } };
  }>({
    queryKey: ['payouts'],
    queryFn: async () => {
      const res = await fetch('/api/payouts');
      if (!res.ok) throw new Error('Could not load payouts');
      return res.json();
    },
  });

  const saveBank = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/sellers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const out = await readJson(res);
      if (!res.ok) throw new Error(out.error ?? 'Could not save');
      return out;
    },
    onSuccess: () => {
      toast({ title: 'Payout account saved', description: 'Future payouts go to this bank account.' });
      queryClient.invalidateQueries({ queryKey: ['my-store'] });
    },
    onError: (e: Error) => toast({ title: 'Could not save payout account', description: e.message, variant: 'destructive' }),
  });

  const s = payouts.data?.summary;
  const statusBadge = (status: string, held?: boolean, orderStatus?: string | null) =>
    // The order was cancelled/refunded/returned — this payout will not be paid.
    held ? <Badge variant="outline" className="border-destructive/40 text-destructive">on hold · order {orderStatus ?? 'cancelled'}</Badge>
    : status === 'paid' ? <Badge className="bg-primary/15 text-primary" variant="secondary">paid</Badge>
      : status === 'processing' ? <Badge variant="outline" className="border-primary/40 text-primary">processing</Badge>
      : <Badge variant="secondary">pending</Badge>;

  return (
    <section className="mt-8 rounded-lg border bg-card p-4 sm:p-6" aria-labelledby="payouts-heading">
      <h2 id="payouts-heading" className="flex items-center gap-2 text-lg font-bold"><Wallet className="h-5 w-5 text-primary" /> Payouts — how you get paid</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Buyers pay in the app and every paid order queues your earnings automatically: the order&apos;s product subtotal, less the {s ? `${s.feePercent}%` : '5%'} marketplace fee, paid out to your bank account below.
      </p>

      {payouts.isLoading ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-4" aria-busy="true">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}</div>
      ) : s && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Gross earnings</p>
              <p className="mt-1 text-xl font-bold">{formatMoney(s.grossCents)}</p>
              <p className="text-[11px] text-muted-foreground">{s.count} paid order{s.count === 1 ? '' : 's'}</p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Marketplace fee</p>
              <p className="mt-1 text-xl font-bold">{formatMoney(s.feeCents)}</p>
              <p className="text-[11px] text-muted-foreground">{s.feePercent}% of gross</p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Net to you</p>
              <p className="mt-1 text-xl font-bold text-primary">{formatMoney(s.netCents)}</p>
              <p className="text-[11px] text-muted-foreground">{formatMoney(s.paid.netCents)} already paid out</p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payout queue</p>
              <p className="mt-1 text-xl font-bold">{formatMoney(s.pending.netCents + s.processing.netCents - (s.held?.netCents ?? 0))}</p>
              <p className="text-[11px] text-muted-foreground">{s.pending.count} pending · {s.processing.count} processing{s.held?.count ? ` · ${s.held.count} on hold (order cancelled, refunded or returned)` : ''}</p>
            </div>
          </div>

          {payouts.data?.payouts.length ? (
            <div className="mt-4 overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Payout</TableHead>
                    <TableHead>Order</TableHead>
                    <TableHead>Gross</TableHead>
                    <TableHead>Fee</TableHead>
                    <TableHead>Net</TableHead>
                    <TableHead>Destination</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payouts.data.payouts.slice(0, 10).map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-mono text-xs">{p.reference}</TableCell>
                      <TableCell className="font-mono text-xs">{p.orderNumber}</TableCell>
                      <TableCell>{formatMoney(p.grossCents)}</TableCell>
                      <TableCell className="text-muted-foreground">−{formatMoney(p.feeCents)}</TableCell>
                      <TableCell className="font-semibold">{formatMoney(p.netCents)}</TableCell>
                      <TableCell className="max-w-44 truncate text-xs text-muted-foreground">{p.destination}</TableCell>
                      <TableCell>{statusBadge(p.status, p.held, p.orderStatus)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">No payouts yet — they appear here automatically the moment a buyer pays an order in-app.</p>
          )}
        </>
      )}

      <div className="mt-5 border-t pt-4">
        <p className="flex items-center gap-2 text-sm font-semibold"><Landmark className="h-4 w-4 text-primary" /> Payout bank account</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Where your money is sent. Only the last digits ever appear to buyers or in admin views.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="po-bank" className="text-xs font-semibold text-muted-foreground">Bank name</label>
            <Input id="po-bank" value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} placeholder="FNB, Capitec, Standard Bank…" className="mt-1" />
          </div>
          <div>
            <label htmlFor="po-type" className="text-xs font-semibold text-muted-foreground">Account type</label>
            <select
              id="po-type"
              className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none"
              value={form.bankAccountType}
              onChange={(e) => setForm({ ...form, bankAccountType: e.target.value })}
            >
              <option value="">Select…</option>
              <option value="cheque">Cheque</option>
              <option value="savings">Savings</option>
              <option value="transmission">Transmission</option>
            </select>
          </div>
          <div>
            <label htmlFor="po-acc" className="text-xs font-semibold text-muted-foreground">Account number</label>
            <Input id="po-acc" inputMode="numeric" value={form.bankAccountNumber} onChange={(e) => setForm({ ...form, bankAccountNumber: e.target.value.replace(/\D/g, '').slice(0, 17) })} className="mt-1" />
          </div>
          <div>
            <label htmlFor="po-branch" className="text-xs font-semibold text-muted-foreground">Branch code</label>
            <Input id="po-branch" inputMode="numeric" value={form.bankBranchCode} onChange={(e) => setForm({ ...form, bankBranchCode: e.target.value.replace(/\D/g, '').slice(0, 6) })} className="mt-1" />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="po-holder" className="text-xs font-semibold text-muted-foreground">Account holder</label>
            <Input id="po-holder" value={form.bankAccountHolder} onChange={(e) => setForm({ ...form, bankAccountHolder: e.target.value })} className="mt-1" />
          </div>
        </div>
        <Button className="mt-3" onClick={() => saveBank.mutate()} disabled={saveBank.isPending}>
          {saveBank.isPending ? 'Saving…' : 'Save payout account'}
        </Button>
      </div>
    </section>
  );
}
