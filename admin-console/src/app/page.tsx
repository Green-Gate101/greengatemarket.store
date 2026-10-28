'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CardSchemeLogos, ProcessorLogo, ProcessorLogoStrip } from './payment-logos';

/**
 * Green Gate — standalone Admin Console.
 *
 * Talks only to this app's own /api/console/* proxy, which attaches the
 * marketplace session server-side. The browser never touches the marketplace
 * API directly and never sees session tokens.
 *
 * All figures come from the marketplace's live database via GET /api/admin
 * (no sampling, no placeholders). Actions are forwarded to POST /api/admin
 * which enforces role, rate limits and audit logging.
 */

// ---------------------------------------------------------------------------
// Types (mirrors of the marketplace's /api/admin response)
// ---------------------------------------------------------------------------

interface AdminUser {
  id?: string; email: string; name: string | null; role: string;
  banned?: boolean; phone?: string | null; createdAt: string;
}
interface AdminStore {
  id: string; slug: string; name: string; email: string; status: string;
  productCount: number; createdAt: string; verified?: boolean;
}
interface AdminOrder {
  id: string; number: string; status: string; paymentStatus: string;
  buyerName: string; buyerEmail: string; totalCents: number; createdAt: string;
  courierTrackingRef?: string | null; courierStatus?: string | null;
  store?: { name?: string };
}
interface AdminApplication {
  id: string; slug: string; name: string; email?: string; location?: string;
  createdAt: string; applicationAt?: string | null; owner?: { email?: string; name?: string | null };
}
/** One store's seller application exactly as the seller filled it in (GET /api/admin/application). */
interface ApplicationDetail {
  id: string; slug: string; name: string; description: string | null; location: string; phone: string; status: string;
  createdAt: string; applicationAt: string | null; logo: string | null; banner: string | null; productCount: number; verified?: boolean;
  owner: { id: string; email: string; name: string | null; memberSince: string };
  business: {
    businessName: string | null; businessType: string | null; registrationNumber: string | null;
    taxNumber: string | null; idNumber: string | null; websiteOrSocial: string | null; ownsBrand: boolean;
  };
  address: { streetAddress: string | null; city: string | null; province: string | null; postalCode: string | null };
  banking: {
    bankName: string | null; bankAccountType: string | null; bankAccountNumber: string | null;
    bankBranchCode: string | null; bankAccountHolder: string | null;
  };
  operations: {
    productCategories: string | null; sourcing: string | null; monthlyVolume: string | null;
    dispatchDays: number | null; returnsDays: number | null;
  };
  declarations: { confirmAge: boolean; confirmAccuracy: boolean; confirmTerms: boolean; signature?: string | null };
}
interface AdminAudit {
  id: string; action: string; target: string | null; detail: string | null;
  actorEmail: string | null; createdAt: string;
}
interface Insights {
  windowDays: number; searchTotal: number;
  topSearches: { term: string; count: number }[];
  emptySearches: { term: string; count: number }[];
  featureUsage: { type: string; count: number }[];
  apiUsage: { service: string; calls: number }[];
  services: Record<string, boolean>;
}
interface DailyCell {
  date: string; orders: number; revenueCents: number; sellerEarningsCents: number; deliveryCents: number;
  users: number; sellers: number; products: number; stores: number; applications: number;
}
interface AdminPayment {
  id: string; reference: string; orderNumber: string; buyerName: string;
  provider: string; method: string; status: string; amountCents: number;
  cardBrand: string | null; cardLast4: string | null; failureReason: string | null; createdAt: string;
}
interface AdminData {
  users: { total: number; sellers: number; buyers: number; banned: number; recent: AdminUser[] };
  stores: AdminStore[];
  products: { total: number; pending: number; approved: number; disabled: number };
  orders: { total: number; pendingPayment: number; sales: number; revenueCents: number; recent: AdminOrder[] };
  statuses: {
    orders?: Record<string, number>; payments?: Record<string, number>;
    users?: Record<string, number>; stores?: Record<string, number>; products?: Record<string, number>;
  };
  insights?: Insights;
  daily?: DailyCell[];
  payments?: {
    paid: number; failed: number; successRatePct: number | null; volumeCents: number;
    byProvider: { provider: string; count: number; volumeCents: number }[];
    recent: AdminPayment[];
  };
  payouts?: {
    pending: { count: number; netCents: number };
    processing: { count: number; netCents: number };
    paid: { count: number; netCents: number };
    /** Unpaid payouts whose order was cancelled/refunded/returned — never to be paid. */
    held?: { count: number; netCents: number };
    feePercent: number;
  };
  paymentEngine?: { ggpayMode: 'test' | 'live'; feePercent: number };
  /** Payout queue rows for the Finance tab — gained releasedAt; held is also true while the money sits in escrow. */
  payoutRows?: PayoutRow[];
  /** Escrow wallet summary for the Finance tab (additive). */
  finance?: FinanceSummary;
  applications: AdminApplication[];
  auditLogs: AdminAudit[];
  categories?: { id: string; name: string; slug: string }[];
  subscriptions?: {
    summary: {
      paid: number; trial: number; expired: number; free: number; notActive: number;
      revenueThisMonthCents: number; paymentsThisMonth: number;
      revenueLast30Cents: number; paymentsLast30: number;
      revenueAllTimeCents: number; paymentsAllTime: number;
      paymentsOn?: boolean; paymentsDetail?: string;
      priceMonthlyCents?: number; priceYearlyCents?: number; trialDays?: number;
    };
    stores: BillingStore[];
    payments: SubscriptionPaymentRow[];
  };
  messageThreads?: MessageThread[];
  discountCodes?: AdminDiscountCode[];
}
/** A seller's discount code (the seller funds it); the console can switch it off. */
interface AdminDiscountCode {
  id: string; code: string; storeId: string; storeName: string; label: string; conditions: string[];
  usedCount: number; maxUses: number | null; active: boolean; disabledByAdmin: boolean;
  expiresAt: string | null; createdAt: string;
}
type BillingState = 'free' | 'trial' | 'paid' | 'expired' | 'not_active';
interface BillingStore {
  id: string; name: string; slug: string; status: string; createdAt: string;
  ownerEmail: string; ownerName: string | null; adminOwned: boolean;
  state: BillingState; accessUntil: string | null; trialEndsAt: string | null; paidUntil: string | null;
  plan: 'monthly' | 'yearly' | null; daysLeft: number | null; billingExempt: boolean; billingExemptNote: string | null;
  totalPaidCents: number; paymentsCount: number; lastPaidAt: string | null;
}
interface SubscriptionPaymentRow {
  id: string; reference: string; plan: string; amountCents: number; status: string;
  storeId: string; storeName: string; createdAt: string; paidAt: string | null; periodStart: string | null; periodEnd: string | null;
}
interface MessageThread {
  storeId: string; storeName: string; unread: number; lastAt: string;
  messages: { id: string; fromAdmin: boolean; body: string; createdAt: string; readAt: string | null }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const money = (cents: number) => {
  try {
    return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', minimumFractionDigits: 2 }).format((cents ?? 0) / 100);
  } catch { return `R ${((cents ?? 0) / 100).toFixed(2)}`; }
};
/** Whole rands with a thin space ("R6 999") — written by hand: some browsers lack en-ZA number data. */
const rands = (cents: number) => `R${Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')}${cents % 100 ? `,${String(cents % 100).padStart(2, '0')}` : ''}`;
const fmtDate = (iso: string) => {
  try { return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return iso; }
};
const fmtWhen = (iso: string) => {
  try { return new Date(iso).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
};

const FEATURE_LABELS: Record<string, string> = {
  product_view: 'Product views', view: 'Product views',
  add_to_cart: 'Add to cart', cart_add: 'Add to cart',
  add_to_wishlist: 'Wishlist saves', wishlist_add: 'Wishlist saves',
  review: 'Reviews written', checkout_start: 'Checkouts started', search: 'Searches',
};
// String.replace with a global regex (NOT replaceAll) — replaceAll needs
// Chrome 85+/Safari 13.1+, inside this app's declared support floor
// (chrome69/safari12.1). Keeps the Insights tab working on old devices.
const featureLabel = (t: string) => FEATURE_LABELS[t] ?? t.replace(/_/g, ' ');

// Payment processor display names for the payments bar chart.
const PROVIDER_BAR_LABELS: Record<string, string> = {
  ggpay_card: 'GGPay card (in-app)',
  ozow: 'Ozow instant EFT (seller, in-app)',
  payfast_seller: 'PayFast card/EFT (seller, in-app)',
  payfast: 'PayFast (marketplace)',
  yoco: 'Yoco card (seller)',
  bank_transfer: 'Bank transfer (EFT)',
};

const SERVICE_META: Record<string, { label: string; manage: string; manageLabel: string; cost: string }> = {
  resend: {
    label: 'Resend — transactional email (order confirmations, verification, password resets)',
    manage: 'https://dashboard.resend.com/billing', manageLabel: 'Resend billing',
    cost: 'Free tier: 3,000 emails/month (100/day). Paid plans from ~$20/month once you outgrow it. Pay by card in the Resend dashboard.',
  },
  courier_guy: {
    label: 'The Courier Guy — live delivery quotes at checkout (collections are booked outside the app for now)',
    manage: 'https://thecourierguy.co.za/', manageLabel: 'Courier Guy account',
    cost: 'Quotes are free; you pay per shipment at your account rates. Top up / settle in your Courier Guy portal.',
  },
  geocode: {
    label: 'Address search & geocoding (Nominatim + Photon)',
    manage: 'https://operations.osmfoundation.org/policies/nominatim/', manageLabel: 'Usage policy',
    cost: 'Free public endpoints — no payment required. If traffic ever outgrows fair-use limits, switch to Google Maps Platform (pay-as-you-go, card required).',
  },
  algolia: {
    label: 'Algolia — instant typo-tolerant search (optional)',
    manage: 'https://dashboard.algolia.com/account/billing', manageLabel: 'Algolia billing',
    cost: 'Free tier: 10,000 searches/month. Paid from ~$49/month. Optional — the database search fallback works without it.',
  },
  remove_bg: {
    label: 'remove.bg — white backgrounds for busy product photos (optional)',
    manage: 'https://www.remove.bg/dashboard#api-key', manageLabel: 'remove.bg dashboard',
    cost: 'Used only for photos the built-in cut cannot clean (busy rooms, textured tables). Pay-as-you-go credits; a free account gives a small number of low-resolution results a month. Add REMOVE_BG_API_KEY in Vercel to switch it on.',
  },
};

const ORDER_STATUS: Record<string, string> = {
  pending_payment: 'Pending payment', confirmed: 'Payment confirmed', processing: 'Processing',
  packed: 'Packed', ready_for_collection: 'Ready for collection', shipped: 'Shipped',
  in_transit: 'In transit', out_for_delivery: 'Out for delivery', delivered: 'Delivered',
  cancelled: 'Cancelled', returned: 'Returned', refunded: 'Refunded',
};
const pillClass = (status: string): string => {
  if (['active', 'approved', 'delivered', 'confirmed', 'paid', 'ADMIN'].includes(status)) return 'pill ok';
  if (['pending', 'pending_review', 'pending_payment', 'awaiting_payment', 'suspended'].includes(status)) return 'pill warn';
  if (['declined', 'disabled', 'archived', 'cancelled', 'refunded', 'rejected'].includes(status)) return 'pill bad';
  return 'pill muted';
};

type TabKey = 'overview' | 'monitor' | 'stores' | 'subscriptions' | 'messages' | 'discounts' | 'orders' | 'money' | 'finance' | 'users' | 'insights' | 'billing' | 'audit';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'monitor', label: 'System monitor' },
  { key: 'stores', label: 'Stores' },
  { key: 'subscriptions', label: 'Subscriptions' },
  { key: 'messages', label: 'Messages' },
  { key: 'discounts', label: 'Discounts' },
  { key: 'orders', label: 'Orders' },
  { key: 'money', label: 'Payments & payouts' },
  { key: 'finance', label: 'Finance' },
  { key: 'users', label: 'Users' },
  { key: 'insights', label: 'Insights' },
  { key: 'billing', label: 'API & billing' },
  { key: 'audit', label: 'Audit log' },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Page() {
  const [checking, setChecking] = useState(true);
  const [authed, setAuthed] = useState(false);
  const [data, setData] = useState<AdminData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loadedAt, setLoadedAt] = useState('');
  const [tab, setTab] = useState<TabKey>('overview');
  const [busy, setBusy] = useState('');
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const res = await fetch('/api/console/data', { cache: 'no-store' });
      if (res.status === 401) { setAuthed(false); setData(null); return; }
      // A host error page (HTML) reads as a plain message, never "Unexpected token '<'".
      const json = (await res.json().catch(() => ({
        error: res.ok ? 'The server sent an unexpected answer. Please try again.' : `The server is busy right now (error ${res.status}). Please try again in a moment.`,
      }))) as AdminData & { error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
      setLoadedAt(new Date().toLocaleTimeString());
      setAuthed(true);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the dashboard.');
    }
  }, []);

  useEffect(() => { void load().finally(() => setChecking(false)); }, [load]);
  // A link such as https://admin.greengatemarket.store/#messages (the
  // "Message from <store>" notification) opens that tab.
  useEffect(() => {
    const fromHash = () => {
      const key = window.location.hash.replace(/^#\/?/, '');
      if (TABS.some((t) => t.key === key)) setTab(key as TabKey);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  const act = useCallback(async (action: string, targetId: string, value?: string, confirmText?: string, extra?: Record<string, string>, quiet?: boolean): Promise<boolean> => {
    if (confirmText && !window.confirm(confirmText)) return false;
    setBusy(action + targetId);
    if (!quiet) setFlash(null);
    try {
      const res = await fetch('/api/console/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(extra ?? {}), action, targetId, ...(value === undefined ? {} : { value }) }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean };
      if (res.status === 401) { setAuthed(false); setFlash({ kind: 'err', text: 'Session expired — sign in again.' }); return false; }
      if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
      if (!quiet) setFlash({ kind: 'ok', text: 'Done.' });
      await load();
      return true;
    } catch (e) {
      setFlash({ kind: 'err', text: e instanceof Error ? e.message : 'Action failed.' });
      return false;
    } finally {
      setBusy('');
    }
  }, [load]);
  const [messageStore, setMessageStore] = useState('');
  // The seller application open in the Stores tab ('' = none).
  const [openApplication, setOpenApplication] = useState('');
  const unreadMessages = (data?.messageThreads ?? []).reduce((n, t) => n + t.unread, 0);
  // While the Messages tab is open (and the browser tab is visible), sellers'
  // replies appear on their own: the data is re-read every 15 seconds.
  const busyRef = useRef(busy);
  // Keep the ref current AFTER commit (the canonical latest-ref pattern) —
  // the interval below only reads it, so a post-paint update is equivalent
  // and satisfies the ref-during-render rule.
  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => {
    if (tab !== 'messages' || !authed) return;
    const iv = setInterval(() => {
      if (document.visibilityState === 'visible' && busyRef.current === '') void load();
    }, 15_000);
    return () => clearInterval(iv);
  }, [tab, authed, load]);

  const logout = useCallback(async () => {
    // Signed out locally even when the network is down (the parked session
    // still expires on its own).
    try {
      await fetch('/api/console/logout', { method: 'POST' });
    } catch { /* offline — fall through */ }
    setAuthed(false); setData(null);
  }, []);

  if (checking) {
    return (
      <div className="shell">
        <TopBar signedIn={false} onLogout={logout} />
        <main><p className="muted">Checking session…</p></main>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="shell">
        <TopBar signedIn={false} onLogout={logout} />
        <main>
          <div className="login-wrap">
            <SignInCard onSuccess={() => void load()} />
            {loadError && <div className="error-box">{loadError}</div>}
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="shell">
      <TopBar signedIn onLogout={logout} />
      <main>
        <nav className="tabs" aria-label="Admin sections">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}{t.key === 'messages' && unreadMessages > 0 ? ` (${unreadMessages})` : ''}
            </button>
          ))}
        </nav>

        {flash && <div className={flash.kind === 'ok' ? 'ok-box' : 'error-box'} role="status">{flash.text}</div>}
        {loadError && <div className="error-box" role="alert">{loadError}{data && loadedAt ? <span className="muted"> — showing data loaded at {loadedAt}; act only once a retry succeeds.</span> : null} <button className="btn" onClick={() => void load()}>Retry</button></div>}
        {!data ? <p className="muted mt14">Loading dashboard…</p> : (
          <>
            {tab === 'overview' && <Overview d={data} onOpenApplication={(id) => { setOpenApplication(id); setTab('stores'); }} />}
            {tab === 'monitor' && <SystemMonitor onSignedOut={() => { setAuthed(false); setData(null); }} />}
            {tab === 'stores' && <Stores d={data} act={act} busy={busy} openApplication={openApplication} onOpenApplication={setOpenApplication} onSignedOut={() => { setAuthed(false); setData(null); }} />}
            {tab === 'subscriptions' && <Subscriptions d={data} act={act} busy={busy} onMessage={(id) => { setMessageStore(id); setTab('messages'); }} />}
            {tab === 'messages' && <Messages d={data} act={act} busy={busy} selected={messageStore} onSelect={setMessageStore} onRefresh={load} />}
            {tab === 'discounts' && <Discounts d={data} act={act} busy={busy} />}
            {tab === 'orders' && <Orders d={data} act={act} busy={busy} />}
            {tab === 'money' && <Money d={data} act={act} busy={busy} />}
            {tab === 'finance' && <Finance d={data} act={act} busy={busy} onRefresh={load} onSessionExpired={() => setAuthed(false)} />}
            {tab === 'users' && <Users d={data} act={act} busy={busy} />}
            {tab === 'insights' && <InsightsPanel d={data} />}
            {tab === 'billing' && <Billing d={data} />}
            {tab === 'audit' && <Audit d={data} />}
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function TopBar({ signedIn, onLogout }: { signedIn: boolean; onLogout: () => void }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="mark" aria-hidden>GG</span>
        <div>
          Admin Console
          <div className="sub">Green Gate · greengatemarket.store</div>
        </div>
      </div>
      <div className="btnrow">
        <a className="btn" href="https://greengatemarket.store" target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>Open storefront ↗</a>
        {signedIn && <button className="btn" onClick={onLogout}>Sign out</button>}
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="footer safe">
      Green Gate admin console · figures are computed live from the marketplace database · actions are audited.
    </footer>
  );
}

function SignInCard({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/console/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || 'Sign-in failed.');
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally { setBusy(false); }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Administrator sign-in</h2>
      <p className="hint">Use your Green Gate administrator email and password (the same credentials as the marketplace).</p>
      <label htmlFor="gg-email">Email</label>
      <input id="gg-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor="gg-password">Password</label>
      <input id="gg-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      <div className="btnrow"><button className="btn primary" type="submit" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button></div>
      {error && <div className="error-box" role="alert">{error}</div>}
      <p className="small muted mt14">
        Forgot the password? Use “Forgot password?” on the marketplace sign-in page — a reset link is emailed to the administrator address.
      </p>
    </form>
  );
}

function Overview({ d, onOpenApplication }: { d: AdminData; onOpenApplication: (storeId: string) => void }) {
  const storeStatuses = d.statuses?.stores ?? {};
  return (
    <>
      <div className="card">
        <h2>Marketplace at a glance</h2>
        <p className="hint">Live totals from the marketplace database.</p>
        <div className="grid">
          <div className="stat"><div className="label">Accounts</div><div className="value mono">{d.users.total}</div><div className="detail">{d.users.sellers} sellers · {d.users.buyers} buyers</div></div>
          <div className="stat"><div className="label">Suspended</div><div className="value mono">{d.users.banned ?? 0}</div><div className="detail">banned accounts (data kept)</div></div>
          <div className="stat"><div className="label">Stores</div><div className="value mono">{d.stores.length}</div><div className="detail">{storeStatuses.active ?? 0} active · {storeStatuses.pending ?? 0} pending</div></div>
          <div className="stat"><div className="label">Products</div><div className="value mono">{d.products.total}</div><div className="detail">{d.products.approved} live · {d.products.pending} awaiting review</div></div>
          <div className="stat"><div className="label">Sales</div><div className="value mono">{d.orders.sales}</div><div className="detail">{money(d.orders.revenueCents)} gross</div></div>
          <div className="stat"><div className="label">Awaiting payment</div><div className="value mono">{d.orders.pendingPayment}</div><div className="detail">{d.payments ? `${d.payments.paid} paid in-app automatically` : 'confirm after EFT / proof of payment'}</div></div>
        </div>
      </div>
      <div className="card">
        <h2>Orders &amp; revenue — last 14 days</h2>
        <p className="hint">Real orders per day (columns) with the day&apos;s gross revenue — every figure from the orders table.</p>
        {d.daily && d.daily.length > 0 ? <DailyChart cells={d.daily} /> : <p className="muted small">No activity yet — the chart fills in as orders arrive.</p>}
        {d.daily && d.daily.length > 0 && (
          <div className="grid mt14">
            <div className="stat"><div className="label">Orders (14 days)</div><div className="value mono">{d.daily.reduce((s, c) => s + c.orders, 0)}</div></div>
            <div className="stat"><div className="label">Revenue (14 days)</div><div className="value mono">{money(d.daily.reduce((s, c) => s + c.revenueCents, 0))}</div></div>
            <div className="stat"><div className="label">New accounts (14 days)</div><div className="value mono">{d.daily.reduce((s, c) => s + c.users, 0)}</div></div>
            <div className="stat"><div className="label">New listings (14 days)</div><div className="value mono">{d.daily.reduce((s, c) => s + c.products, 0)}</div></div>
          </div>
        )}
      </div>
      {d.payments && d.payouts && (
        <div className="card">
          <h2>In-app payments (GGPay)</h2>
          <p className="hint">Buyers pay in the app, orders confirm automatically, sellers get paid out to their bank accounts — marketplace fee {d.payouts.feePercent}%.</p>
          <p className="hint" style={{ marginTop: 8 }}>
            <ProcessorLogoStrip size="sm" />
          </p>
          <div className="grid">
            <div className="stat"><div className="label">Card payments settled</div><div className="value mono">{d.payments.paid}</div><div className="detail">{money(d.payments.volumeCents)} volume</div></div>
            <div className="stat"><div className="label">Approval rate</div><div className="value mono">{d.payments.successRatePct !== null ? `${d.payments.successRatePct}%` : '—'}</div><div className="detail">{d.payments.failed} declined attempts</div></div>
            <div className="stat"><div className="label">Payouts owed</div><div className="value mono">{money(d.payouts.pending.netCents + d.payouts.processing.netCents - (d.payouts.held?.netCents ?? 0))}</div><div className="detail">{d.payouts.pending.count} pending · {d.payouts.processing.count} processing{d.payouts.held?.count ? ` · ${d.payouts.held.count} on hold` : ''}</div></div>
            <div className="stat"><div className="label">Payouts completed</div><div className="value mono">{money(d.payouts.paid.netCents)}</div><div className="detail">{d.payouts.paid.count} paid out</div></div>
          </div>
        </div>
      )}
      {d.applications.length > 0 && (
        <div className="card">
          <h2>Store applications awaiting review ({d.applications.length})</h2>
          <p className="hint">New sellers who applied and are waiting for approval.</p>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Store</th><th>Owner</th><th>Location</th><th>Applied</th><th></th></tr></thead>
              <tbody>
                {d.applications.map((a) => (
                  <tr key={a.id}>
                    <td><strong>{a.name}</strong><div className="small muted">/{a.slug}</div></td>
                    <td className="small">{a.owner?.email ?? '—'}</td>
                    <td className="small">{a.location ?? '—'}</td>
                    <td className="small">{fmtDate(a.applicationAt ?? a.createdAt)}</td>
                    <td><button className="btn primary" data-testid="open-application" onClick={() => onOpenApplication(a.id)}>Read application</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted mt8">Read each application in full, then approve or decline it in the <strong>Stores</strong> tab.</p>
        </div>
      )}
    </>
  );
}

interface ActFn {
  (action: string, targetId: string, value?: string, confirmText?: string, extra?: Record<string, string>, quiet?: boolean): Promise<boolean>;
}

function Stores({ d, act, busy, openApplication, onOpenApplication, onSignedOut }: {
  d: AdminData; act: ActFn; busy: string;
  openApplication: string; onOpenApplication: (storeId: string) => void; onSignedOut: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Opening an application (here or from the Overview) brings it into view.
  useEffect(() => {
    if (openApplication) panelRef.current?.scrollIntoView({ block: 'start' });
  }, [openApplication]);
  return (
    <>
    {openApplication && (
      <div ref={panelRef} className="app-panel-wrap">
        <ApplicationPanel key={openApplication} storeId={openApplication} categories={d.categories ?? []} act={act} busy={busy} onClose={() => onOpenApplication('')} onSignedOut={onSignedOut} />
      </div>
    )}
    {d.applications.length > 0 && (
      <div className="card">
        <h2>Applications waiting for review ({d.applications.length})</h2>
        <p className="hint">Oldest first. Read what each seller wrote, then approve or decline.</p>
        <ul className="app-queue">
          {d.applications.map((a) => (
            <li key={a.id}>
              <div>
                <strong>{a.name}</strong>
                <div className="small muted">{a.owner?.email ?? '—'} · applied {fmtDate(a.applicationAt ?? a.createdAt)}</div>
              </div>
              <button className={openApplication === a.id ? 'btn' : 'btn primary'} data-testid="queue-open-application" onClick={() => onOpenApplication(openApplication === a.id ? '' : a.id)}>
                {openApplication === a.id ? 'Close' : 'Read application'}
              </button>
            </li>
          ))}
        </ul>
      </div>
    )}
    <div className="card">
      <h2>Stores ({d.stores.length})</h2>
      <p className="hint">Approve applications, suspend or reinstate stores. Suspending a store hides its listings but never deletes the business. “Application” shows what the seller wrote when they applied.</p>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Store</th><th>Owner</th><th>Status</th><th>Products</th><th>Joined</th><th>Actions</th></tr></thead>
          <tbody>
            {d.stores.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong><div className="small muted">/{s.slug}</div></td>
                <td className="small">{s.email}</td>
                <td><span className={pillClass(s.status)}>{s.status}</span>{s.verified && <span className="pill ok" style={{ marginLeft: 4 }} data-testid="verified-pill">verified</span>}</td>
                <td className="mono">{s.productCount}</td>
                <td className="small">{fmtDate(s.createdAt)}</td>
                <td>
                  <div className="btnrow">
                    {/* Values must match the marketplace admin API whitelist
                        (active | suspended | declined) — the console's old
                        verbs (approve/decline/suspend/reinstate) were rejected
                        with 400 and every store moderation failed. */}
                    {s.status === 'pending' && (
                      <>
                        <button className="btn primary" disabled={busy !== ''} onClick={() => void act('store_status', s.id, 'active')}>Approve</button>
                        <button className="btn danger" disabled={busy !== ''} onClick={() => void act('store_status', s.id, 'declined')}>Decline</button>
                      </>
                    )}
                    {s.status === 'active' && (
                      <button className="btn danger" disabled={busy !== ''} onClick={() => void act('store_status', s.id, 'suspended', `Suspend "${s.name}"? Its listings will be hidden until reinstated.`)}>Suspend</button>
                    )}
                    {s.status === 'suspended' && (
                      <button className="btn primary" disabled={busy !== ''} onClick={() => void act('store_status', s.id, 'active')}>Reinstate</button>
                    )}
                    {s.status === 'active' && !s.verified && (
                      <button className="btn" data-testid="store-verify" disabled={busy !== ''} onClick={() => void act('store_verified', s.id, 'on', verifyConfirm(s.name))}>Mark verified</button>
                    )}
                    {s.verified && (
                      <button className="btn danger" data-testid="store-unverify" disabled={busy !== ''} onClick={() => void act('store_verified', s.id, 'off', `Remove the Verified seller badge from "${s.name}"?`)}>Remove verified</button>
                    )}
                    <button className="btn" data-testid="store-application" onClick={() => onOpenApplication(s.id)}>Application</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
    </>
  );
}

/** Buyers trust the badge — set it only after a real check. */
const verifyConfirm = (name: string) =>
  `Mark "${name}" as a Verified seller?\n\nOnly do this after you have checked the seller's identity and bank details. Buyers see the badge on the store and product pages.`;

const BUSINESS_TYPE_LABELS: Record<string, string> = {
  individual: 'Individual / sole trader (no registered entity)', sole_proprietor: 'Sole proprietorship',
  partnership: 'Partnership', pty: 'Private company (Pty) Ltd', cc: 'Close corporation', other: 'Other',
};
const SOURCING_LABELS: Record<string, string> = {
  own_make: 'They make the products themselves', wholesale: 'Wholesale suppliers',
  vintage: 'Vintage / second-hand sourcing', mixed: 'A mix of these',
};
const ACCOUNT_TYPE_LABELS: Record<string, string> = { cheque: 'Cheque / current', savings: 'Savings', transmission: 'Transmission' };
const VOLUME_LABELS: Record<string, string> = { '1-20': '1–20', '21-50': '21–50', '51-200': '51–200', '201-500': '201–500', '500+': 'More than 500' };

/** A value the seller gave, or a quiet dash when they left it empty. */
function Val({ v }: { v: ReactNode }) {
  return v === null || v === undefined || v === '' ? <span className="muted">—</span> : <>{v}</>;
}
const yesNo = (b: boolean) => (b ? <span className="pill ok">Yes</span> : <span className="pill bad">No</span>);

/**
 * One seller's application, everything they wrote — store, owner, business,
 * address, bank account, how they will trade, declarations and signature —
 * with Approve / Decline (and a reason the seller is sent) while it waits.
 */
function ApplicationPanel({ storeId, categories, act, busy, onClose, onSignedOut }: {
  storeId: string; categories: { name: string; slug: string }[]; act: ActFn; busy: string;
  onClose: () => void; onSignedOut: () => void;
}) {
  const [app, setApp] = useState<ApplicationDetail | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [reason, setReason] = useState('');
  // The parent passes a fresh callback on every render; reading it through a
  // ref keeps the load below from re-running each time the page re-renders.
  const signedOutRef = useRef(onSignedOut);
  // Same latest-ref pattern: update after commit, declared before the effect
  // that reads it so the first poll tick always sees a current callback.
  useEffect(() => { signedOutRef.current = onSignedOut; });

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/console/application?id=${encodeURIComponent(storeId)}`, { cache: 'no-store' });
        if (res.status === 401) { if (live) signedOutRef.current(); return; }
        // A host error page (HTML) reads as a plain message, never "Unexpected token '<'".
        const json = (await res.json().catch(() => ({
          error: res.ok ? 'The server sent an unexpected answer. Please try again.' : `The server is busy right now (error ${res.status}). Please try again in a moment.`,
        }))) as { application?: ApplicationDetail; error?: string };
        if (!res.ok || !json.application) throw new Error(json.error || `HTTP ${res.status}`);
        if (live) { setApp(json.application); setError(''); }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'Could not load the application.');
      }
    })();
    return () => { live = false; };
  }, [storeId, reload]);

  const decide = async (value: 'active' | 'declined') => {
    const done = value === 'active'
      ? await act('store_status', storeId, 'active', `Approve "${app?.name ?? 'this store'}"? It goes live and its free trial starts.`)
      : await act('store_status', storeId, 'declined', `Decline "${app?.name ?? 'this store'}"? The seller is told${reason.trim() ? ' your reason' : ''}.`, reason.trim() ? { note: reason.trim() } : undefined);
    if (done) { setReason(''); setReload((n) => n + 1); }
  };

  const catName = new Map(categories.map((c) => [c.slug, c.name]));
  const cats = (app?.operations.productCategories ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => catName.get(s) ?? s.replace(/[-_]+/g, ' '));
  const web = app?.business.websiteOrSocial ?? '';
  const sig = app?.declarations.signature;

  return (
    <div className="card app-panel" data-testid="application-panel">
      <div className="app-top">
        <h2 style={{ margin: 0 }}>Seller application{app ? ` — ${app.name}` : ''}</h2>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      {!app && !error && <p className="muted">Loading the application…</p>}
      {error && (
        <div className="error-box" role="alert">
          {error} <button className="btn" onClick={() => { setError(''); setReload((n) => n + 1); }}>Try again</button>
        </div>
      )}
      {app && (
        <>
          <div className="app-head">
            {app.logo
              ? <img className="app-logo" src={app.logo} alt={`${app.name} logo`} />
              : <div className="app-logo app-logo-empty" aria-hidden>{app.name.slice(0, 1).toUpperCase()}</div>}
            <div className="app-head-text">
              <div><strong>{app.name}</strong> <span className={pillClass(app.status)}>{app.status === 'pending' ? 'waiting for review' : app.status}</span>{app.verified && <> <span className="pill ok">verified seller</span></>}</div>
              <div className="small muted">/{app.slug} · applied {fmtWhen(app.applicationAt ?? app.createdAt)} · {app.productCount} listing{app.productCount === 1 ? '' : 's'}</div>
            </div>
          </div>

          <div className="app-section mt14">
            <h3>About the store (in the seller’s words)</h3>
            <p className="app-text" data-testid="application-description">{app.description ? app.description : <span className="muted">The seller did not write a description.</span>}</p>
          </div>
          {app.banner && <img className="app-banner" src={app.banner} alt={`${app.name} banner`} />}

          <div className="app-sections">
            <section className="app-section">
              <h3>Store &amp; contact</h3>
              <dl>
                <dt>Store name</dt><dd>{app.name}</dd>
                <dt>Location</dt><dd><Val v={app.location} /></dd>
                <dt>Contact number</dt><dd>{app.phone ? <a href={`tel:${app.phone.replace(/[^\d+]/g, '')}`}>{app.phone}</a> : <Val v="" />}</dd>
                <dt>Owner</dt><dd><Val v={app.owner.name} /></dd>
                <dt>Email</dt><dd><a href={`mailto:${app.owner.email}`}>{app.owner.email}</a></dd>
                <dt>Account since</dt><dd>{fmtDate(app.owner.memberSince)}</dd>
              </dl>
            </section>
            <section className="app-section">
              <h3>Business</h3>
              <dl>
                <dt>Business type</dt><dd><Val v={app.business.businessType ? BUSINESS_TYPE_LABELS[app.business.businessType] ?? app.business.businessType : ''} /></dd>
                <dt>Registered name</dt><dd><Val v={app.business.businessName} /></dd>
                <dt>Registration no.</dt><dd><Val v={app.business.registrationNumber} /></dd>
                {app.business.taxNumber && (<><dt>Tax number</dt><dd>{app.business.taxNumber}</dd></>)}
                {app.business.idNumber && (<><dt>ID / passport</dt><dd>{app.business.idNumber}</dd></>)}
                <dt>Website / social</dt><dd>{/^https?:\/\/\S+$/i.test(web) ? <a href={web} target="_blank" rel="noopener noreferrer nofollow">{web}</a> : <Val v={web} />}</dd>
                <dt>Makes or owns the brand</dt><dd>{yesNo(app.business.ownsBrand)}</dd>
              </dl>
            </section>
            <section className="app-section">
              <h3>Address (collections &amp; returns)</h3>
              <dl>
                <dt>Street</dt><dd><Val v={app.address.streetAddress} /></dd>
                <dt>City / town</dt><dd><Val v={app.address.city} /></dd>
                <dt>Province</dt><dd><Val v={app.address.province} /></dd>
                <dt>Postal code</dt><dd><Val v={app.address.postalCode} /></dd>
              </dl>
            </section>
            <section className="app-section">
              <h3>Bank account for payouts</h3>
              <dl>
                <dt>Bank</dt><dd><Val v={app.banking.bankName} /></dd>
                <dt>Account type</dt><dd><Val v={app.banking.bankAccountType ? ACCOUNT_TYPE_LABELS[app.banking.bankAccountType] ?? app.banking.bankAccountType : ''} /></dd>
                <dt>Account number</dt><dd className="mono"><Val v={app.banking.bankAccountNumber} /></dd>
                <dt>Branch code</dt><dd className="mono"><Val v={app.banking.bankBranchCode} /></dd>
                <dt>Account holder</dt><dd><Val v={app.banking.bankAccountHolder} /></dd>
              </dl>
            </section>
            <section className="app-section">
              <h3>How they will sell</h3>
              <dl>
                <dt>Categories</dt><dd><Val v={cats.join(', ')} /></dd>
                <dt>Products come from</dt><dd><Val v={app.operations.sourcing ? SOURCING_LABELS[app.operations.sourcing] ?? app.operations.sourcing : ''} /></dd>
                <dt>Orders per month</dt><dd><Val v={app.operations.monthlyVolume ? VOLUME_LABELS[app.operations.monthlyVolume] ?? app.operations.monthlyVolume : ''} /></dd>
                <dt>Dispatch time</dt><dd><Val v={app.operations.dispatchDays === null ? '' : `${app.operations.dispatchDays} day${app.operations.dispatchDays === 1 ? '' : 's'} after an order`} /></dd>
                <dt>Return window</dt><dd><Val v={app.operations.returnsDays === null ? '' : app.operations.returnsDays === 0 ? 'No returns' : `${app.operations.returnsDays} days`} /></dd>
              </dl>
            </section>
            <section className="app-section">
              <h3>Declarations</h3>
              <dl>
                <dt>18 or older, allowed to trade</dt><dd>{yesNo(app.declarations.confirmAge)}</dd>
                <dt>Information is true</dt><dd>{yesNo(app.declarations.confirmAccuracy)}</dd>
                <dt>Accepted seller terms &amp; privacy</dt><dd>{yesNo(app.declarations.confirmTerms)}</dd>
                <dt>Signed (typed name)</dt><dd>{sig ? <strong data-testid="application-signature">{sig}</strong> : <span className="muted">Not recorded — applied before signatures were saved</span>}</dd>
              </dl>
            </section>
          </div>

          {app.status === 'pending' && (
            <div className="app-decide mt14">
              <label htmlFor={`decline-${app.id}`} className="small"><strong>Reason if you decline</strong> (optional — the seller sees it)</label>
              <textarea
                id={`decline-${app.id}`} className="msg-input" rows={2} maxLength={500} value={reason}
                onChange={(e) => setReason(e.target.value)} placeholder="e.g. Please add a clear store description and real product photos."
              />
              <div className="btnrow">
                <button className="btn primary" data-testid="application-approve" disabled={busy !== ''} onClick={() => void decide('active')}>Approve store</button>
                <button className="btn danger" data-testid="application-decline" disabled={busy !== ''} onClick={() => void decide('declined')}>Decline</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Discounts({ d, act, busy }: { d: AdminData; act: ActFn; busy: string }) {
  const codes = d.discountCodes ?? [];
  return (
    <div className="card" data-testid="discounts-tab">
      <h2>Discount codes ({codes.length})</h2>
      <p className="hint">Sellers create codes for their own items and pay for the discount (it comes off their items, never delivery; each buyer can use a code once). Switch off any code that is misleading or abused — the seller is told.</p>
      {codes.length === 0 ? (
        <p className="muted small">No seller has created a discount code yet.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Code</th><th>Store</th><th>Discount</th><th>Conditions</th><th>Used</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.id}>
                  <td className="mono"><strong>{c.code}</strong></td>
                  <td className="small">{c.storeName}</td>
                  <td className="small">{c.label}</td>
                  <td className="small">{c.conditions.join(' · ')}</td>
                  <td className="mono">{c.usedCount}{c.maxUses !== null ? ` / ${c.maxUses}` : ''}</td>
                  <td>
                    <span className={c.disabledByAdmin ? 'pill bad' : c.active ? 'pill ok' : 'pill muted'}>
                      {c.disabledByAdmin ? 'switched off by Green Gate' : c.active ? 'on' : 'off (seller)'}
                    </span>
                  </td>
                  <td>
                    {c.disabledByAdmin ? (
                      <button className="btn" disabled={busy !== ''} onClick={() => void act('discount_code_admin', c.id, 'on', `Allow ${c.code} again? The seller can switch it back on.`)}>Allow again</button>
                    ) : (
                      <button className="btn danger" disabled={busy !== ''} onClick={() => void act('discount_code_admin', c.id, 'off', `Switch off ${c.code} for ${c.storeName}? Buyers can no longer use it and the seller is told.`)}>Switch off</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Orders({ d, act, busy }: { d: AdminData; act: ActFn; busy: string }) {
  return (
    <div className="card">
      <h2>Recent orders ({d.orders.recent.length} newest)</h2>
      <p className="hint">Confirm payments once the money has cleared. Only delete test or junk records — real customer orders should be kept.</p>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Order</th><th>Buyer</th><th>Store</th><th>Total</th><th>Payment</th><th>Status</th><th>Courier</th><th>Placed</th><th>Actions</th></tr></thead>
          <tbody>
            {d.orders.recent.map((o) => (
              <tr key={o.id}>
                <td className="mono small">{o.number}</td>
                <td className="small">{o.buyerName}<div className="muted">{o.buyerEmail}</div></td>
                <td className="small">{o.store?.name ?? '—'}</td>
                <td className="mono">{money(o.totalCents)}</td>
                <td><span className={pillClass(o.paymentStatus)}>{o.paymentStatus}</span></td>
                <td><span className={pillClass(o.status)}>{ORDER_STATUS[o.status] ?? o.status}</span></td>
                <td className="small">{o.courierTrackingRef
                  ? <span className="mono">{o.courierTrackingRef}</span>
                  : o.courierStatus
                    ? <span className="muted">{o.courierStatus.startsWith('booking_failed') ? 'booking failed — retrying' : o.courierStatus}</span>
                    : <span className="muted">—</span>}</td>
                <td className="small">{fmtDate(o.createdAt)}</td>
                <td>
                  <div className="btnrow">
                    {o.paymentStatus === 'awaiting_payment' && (
                      <button className="btn primary" disabled={busy !== ''} onClick={() => void act('confirm_payment', o.id, undefined, `Confirm payment for order ${o.number}?`)}>Confirm payment</button>
                    )}
                    <button
                      className="btn danger"
                      disabled={busy !== ''}
                      onClick={() => void act('delete_order', o.id, undefined, `Delete order ${o.number}? Only delete test or junk records — real customer orders should be kept. This is permanent and audited.`)}
                    >Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Users({ d, act, busy }: { d: AdminData; act: ActFn; busy: string }) {
  return (
    <div className="card">
      <h2>Accounts ({d.users.recent.length} newest of {d.users.total})</h2>
      <p className="hint">
        Banning removes access and hides listings but never terminates the account — data is kept and unbanning restores everything.
        Deletion is permanent and audited; administrators cannot be banned or deleted.
      </p>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Account</th><th>Role</th><th>Joined</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {d.users.recent.map((u) => {
              const id = u.id ?? '';
              const isProtected = u.role === 'ADMIN';
              const ban = !(u.banned ?? false);
              return (
                <tr key={id || u.email}>
                  <td><strong>{u.name || '—'}</strong><div className="small muted">{u.email}{u.phone ? ` · ${u.phone}` : ''}</div></td>
                  <td className="small">{u.role}</td>
                  <td className="small">{fmtDate(u.createdAt)}</td>
                  <td><span className={u.banned ? 'pill bad' : 'pill ok'}>{u.banned ? 'banned' : 'active'}</span></td>
                  <td>
                    {isProtected ? (
                      <span className="small muted">Protected</span>
                    ) : (
                      <div className="btnrow">
                        <button
                          className={ban ? 'btn danger' : 'btn primary'}
                          disabled={busy !== ''}
                          onClick={() => void act(
                            'user_ban', id, String(ban),
                            ban
                              ? `Ban ${u.email}? They lose access and their listings are hidden, but nothing is deleted and you can unban anytime.`
                              : `Unban ${u.email}? Access is restored.`,
                          )}
                        >{ban ? 'Ban' : 'Unban'}</button>
                        <button
                          className="btn danger"
                          disabled={busy !== ''}
                          onClick={() => void act('delete_user', id, undefined, `PERMANENTLY delete ${u.email} and all their data (stores, products, orders)? This cannot be undone and is audited.`)}
                        >Delete</button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BarList({ rows, suffix }: { rows: { term: string; count: number; icon?: ReactNode }[]; suffix?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div>
      {rows.map((r) => (
        <div className="bar-row" key={r.term}>
          <span className="term" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {r.icon}
            {r.term}
          </span>
          <span className="bar"><i style={{ width: `${Math.max(6, Math.round((r.count / max) * 100))}%` }} /></span>
          <span className="count">{r.count}{suffix ?? ''}</span>
        </div>
      ))}
    </div>
  );
}

/** SVG column chart — orders per day with a revenue scale underneath. */
function DailyChart({ cells }: { cells: DailyCell[] }) {
  const W = 560, H = 150, PAD = 6;
  const maxOrders = Math.max(1, ...cells.map((c) => c.orders));
  const maxRev = Math.max(1, ...cells.map((c) => c.revenueCents));
  const slot = W / Math.max(1, cells.length);
  const bw = Math.max(6, Math.min(28, slot * 0.55));
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H + 26}`} role="img" aria-label="Orders and revenue per day, last 14 days" preserveAspectRatio="none">
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={0} x2={W} y1={H - f * (H - PAD)} y2={H - f * (H - PAD)} className="gridline" />
        ))}
        {cells.map((c, i) => {
          const x = i * slot + (slot - bw) / 2;
          const oh = Math.round((c.orders / maxOrders) * (H - PAD));
          const rh = Math.round((c.revenueCents / maxRev) * (H - PAD));
          const label = new Date(`${c.date}T00:00:00Z`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', timeZone: 'UTC' });
          return (
            <g key={c.date}>
              <rect x={x} y={H - oh} width={bw} height={Math.max(1, oh)} rx={2} className="bar-orders"><title>{`${label}: ${c.orders} orders`}</title></rect>
              <rect x={x + bw + 2} y={H - rh} width={Math.max(3, bw - 6)} height={Math.max(1, rh)} rx={2} className="bar-revenue"><title>{`${label}: ${money(c.revenueCents)}`}</title></rect>
              {i % 2 === 0 && <text x={x + bw / 2} y={H + 14} className="axis" textAnchor="middle">{label}</text>}
            </g>
          );
        })}
      </svg>
      <p className="legend small muted"><span className="key orders" /> orders <span className="key revenue" /> revenue</p>
    </div>
  );
}

/**
 * Money — the payments & payouts tab: every charge attempt, the approval
 * scale, the payout pipeline with bars, and the administrator's payout
 * actions (pending → processing → paid) once the EFT to the seller is done.
 */
function Money({ d, act, busy }: { d: AdminData; act: ActFn; busy: string }) {
  const p = d.payments;
  const po = d.payouts;
  if (!p || !po) {
    return (
      <div className="card">
        <h2>Payments &amp; payouts</h2>
        <p className="hint">Payment data appears the first time a buyer pays an order in-app. Older deployments without the payments table show nothing here.</p>
      </div>
    );
  }
  const pipeline = [
    { label: 'Pending', ...po.pending, cls: 'warn' },
    { label: 'Processing', ...po.processing, cls: 'muted' },
    { label: 'Paid out', ...po.paid, cls: 'ok' },
    ...(po.held?.count ? [{ label: 'On hold (order cancelled/refunded)', ...po.held, cls: 'bad' }] : []),
  ];
  const maxNet = Math.max(1, ...pipeline.map((s) => s.netCents));
  return (
    <>
      <div className="card">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          Card payments — in-app (GGPay)
          <CardSchemeLogos size="sm" />
        </h2>
        {d.paymentEngine && (
          <p
            className="hint"
            style={{
              marginTop: 8, padding: '8px 12px', borderRadius: 8,
              border: d.paymentEngine.ggpayMode === 'live' ? '1px solid #2e7d32' : '1px solid #b45309',
              background: d.paymentEngine.ggpayMode === 'live' ? '#e8f5e9' : '#fff7ed',
              color: d.paymentEngine.ggpayMode === 'live' ? '#1b5e20' : '#92400e',
            }}
            role="status"
          >
            {d.paymentEngine.ggpayMode === 'live'
              ? 'GGPay in-app card engine: an acquirer key is set, but no acquirer is connected yet — every card is refused, so no buyer can “pay” without money moving. Buyers pay only through the sellers’ own PayFast / Ozow / Yoco accounts (real money, confirmed instantly — no bank transfers).'
              : 'GGPay in-app card payments are OFF on the live site — the card form is hidden and every card is refused (sandbox test cards only work in local development). Buyers pay only through the sellers’ own PayFast / Ozow / Yoco accounts (real money, confirmed instantly — no bank transfers).'}
          </p>
        )}
        <p className="hint">Buyers pay INSIDE the app and orders confirm automatically — like Amazon / Takealot. Approval rate over all attempts.</p>
        <div className="grid">
          <div className="stat"><div className="label">Settled</div><div className="value mono">{p.paid}</div><div className="detail">{money(p.volumeCents)} volume</div></div>
          <div className="stat"><div className="label">Declined</div><div className="value mono">{p.failed}</div><div className="detail">recorded honestly, order stays unpaid</div></div>
          <div className="stat"><div className="label">Approval rate</div><div className="value mono">{p.successRatePct !== null ? `${p.successRatePct}%` : '—'}</div><div className="detail">all attempts, last 100 shown below</div></div>
        </div>
        {p.byProvider.length > 0 && (
          <>
            <h3 className="small muted mt14">Settled payments by processor</h3>
            <BarList rows={p.byProvider.map((b) => ({ term: PROVIDER_BAR_LABELS[b.provider] ?? b.provider, count: b.count, icon: <ProcessorLogo provider={b.provider} /> }))} suffix=" payments" />
          </>
        )}
        {p.recent.length > 0 && (
          <>
            <h3 className="small muted mt14">Recent payment attempts</h3>
            <div className="tablewrap">
              <table>
                <thead><tr><th>Ref</th><th>Order</th><th>Buyer</th><th>Method</th><th>Amount</th><th>Status</th><th>When</th></tr></thead>
                <tbody>
                  {p.recent.map((pay) => (
                    <tr key={pay.id}>
                      <td className="mono small">{pay.reference}</td>
                      <td className="mono small">{pay.orderNumber}</td>
                      <td className="small">{pay.buyerName}</td>
                      <td className="small" style={{ whiteSpace: 'nowrap' }}>
                        <ProcessorLogo provider={pay.provider} />
                        <span style={{ marginLeft: 6 }}>{pay.provider === 'ggpay_card' ? `GGPay card ${pay.cardBrand ?? ''} ·· ${pay.cardLast4 ?? ''}` : (PROVIDER_BAR_LABELS[pay.provider] ?? pay.provider)}</span>
                      </td>
                      <td className="mono">{money(pay.amountCents)}</td>
                      <td><span className={pillClass(pay.status === 'paid' ? 'paid' : 'rejected')}>{pay.status}{pay.failureReason ? ` — ${pay.failureReason}` : ''}</span></td>
                      <td className="small">{fmtWhen(pay.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <div className="card">
        <h2>Seller payout pipeline</h2>
        <p className="hint">Every paid order queues the seller&apos;s earnings automatically (gross − {po.feePercent}% fee). Advance the status once the EFT to the seller&apos;s bank account is done.</p>
        <div className="bar-row pipe">
          {pipeline.map((s) => (
            <div key={s.label} className="pipe-stage">
              <div className="small muted">{s.label}</div>
              <div className="value mono">{money(s.netCents)}</div>
              <div className="bar"><i className={s.cls} style={{ width: `${Math.max(6, Math.round((s.netCents / maxNet) * 100))}%` }} /></div>
              <div className="small muted">{s.count} payout{s.count === 1 ? '' : 's'}</div>
            </div>
          ))}
        </div>
        <h3 className="small muted mt14">All payouts (newest 100)</h3>
        <PayoutTable d={d} act={act} busy={busy} />
      </div>
    </>
  );
}

function PayoutTable({ d, act, busy }: { d: AdminData; act: ActFn; busy: string }) {
  // Payout rows ride on /api/admin as part of the money payload in future
  // revisions; today the console reads them through the same endpoint's
  // recent-payments lens, so the actionable queue lives in the pipeline above.
  const rows = (d as unknown as { payoutRows?: { id: string; reference: string; orderNumber: string; storeName: string; netCents: number; destination: string; status: string; orderStatus?: string | null; held?: boolean; createdAt: string }[] }).payoutRows ?? [];
  if (rows.length === 0) {
    return <p className="muted small">No payouts yet — the first in-app card payment creates one automatically.</p>;
  }
  return (
    <div className="tablewrap">
      <table>
        <thead><tr><th>Payout</th><th>Order</th><th>Store</th><th>Net</th><th>Destination</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="mono small">{row.reference}</td>
              <td className="mono small">{row.orderNumber}</td>
              <td className="small">{row.storeName}</td>
              <td className="mono">{money(row.netCents)}</td>
              <td className="small">{row.destination}</td>
              <td><span className={row.held ? 'pill bad' : pillClass(row.status === 'paid' ? 'paid' : row.status === 'processing' ? 'pending_payment' : 'awaiting_payment')}>{row.held ? `on hold · order ${row.orderStatus ?? 'cancelled'}` : row.status}</span></td>
              <td>
                {row.held ? (
                  // The buyer's money went (or must go) back — never pay this out.
                  <span className="small muted">The buyer's money must go back to the buyer — do not pay the seller.</span>
                ) : (
                <div className="btnrow">
                  {row.status === 'pending' && <button className="btn" disabled={busy !== ''} onClick={() => void act('payout_status', row.id, 'processing')}>Mark processing</button>}
                  {row.status !== 'paid' && <button className="btn primary" disabled={busy !== ''} onClick={() => void act('payout_status', row.id, 'paid', `Mark payout ${row.reference} as PAID? Only do this once the EFT to ${row.destination} has actually gone out.`)}>Mark paid</button>}
                </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finance — the escrow wallet: courier budget, escrow holds, the payout
// queue (release from escrow) and the ledger tail (additive)
// ---------------------------------------------------------------------------

/** One payout row as the escrow wallet reports it (releasedAt + escrow hold added). */
interface PayoutRow {
  id: string; reference: string; orderNumber: string; storeName: string; netCents: number;
  destination: string; status: string; orderStatus: string | null; held: boolean;
  releasedAt: string | null; createdAt: string;
}
/** One wallet account's balance. */
interface FinanceBalance { kind: string; refId: string | null; label: string | null; kindLabel: string; cents: number; }
/** One ledger movement (newest first). */
interface FinanceLedgerRow {
  id: string; at: string; kind: string; refId: string | null; direction: string;
  amountCents: number; state: string; refType: string; ref: string; memo: string | null;
}
interface FinanceSummary {
  balances: FinanceBalance[];
  shippingBalanceCents: number; escrowHeldCents: number; unreleasedPayouts: number;
  recent: FinanceLedgerRow[];
}

const LEDGER_KIND_LABELS: Record<string, string> = {
  platform_cash: 'Buyer cash', seller_escrow: 'Seller escrow', platform_shipping: 'Courier budget',
  platform_fees: 'Commission', seller_paid: 'Paid to sellers', buyer: 'Buyer refunds', courier_tcg: 'The Courier Guy',
};
const ledgerKindLabel = (kind: string) => LEDGER_KIND_LABELS[kind] ?? kind;
const ledgerStatePill = (state: string) => (state === 'settled' || state === 'released' ? 'pill ok' : state === 'held' ? 'pill warn' : state === 'refunded' ? 'pill bad' : 'pill muted');
/** Short "9 Feb, 14:05" stamp for the ledger tail. */
const fmtShort = (iso: string) => {
  try { return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
};
// max-h-96 (24rem) + overflow-y-auto as inline styles — this console ships plain CSS, no Tailwind.
const FINANCE_SCROLL: React.CSSProperties = { maxHeight: 384, overflowY: 'auto' };

function Finance({ d, act, busy, onRefresh, onSessionExpired }: { d: AdminData; act: ActFn; busy: string; onRefresh: () => Promise<void>; onSessionExpired: () => void }) {
  const f = d.finance;
  const engine = d.paymentEngine;
  const [releasing, setReleasing] = useState('');
  // The marketplace's 409 answer ("order still in transit…") shows under the row's buttons.
  const [releaseError, setReleaseError] = useState<{ id: string; text: string } | null>(null);

  const release = async (row: PayoutRow) => {
    if (!window.confirm(`Release ${row.reference} (order ${row.orderNumber}, ${money(row.netCents)}) from escrow? The earnings become payable to ${row.storeName}.`)) return;
    setReleasing(row.id);
    setReleaseError(null);
    try {
      const res = await fetch('/api/console/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'release_payout', targetId: row.id }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 401) { onSessionExpired(); throw new Error('Session expired — sign in again.'); }
      if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
      await onRefresh();
    } catch (e) {
      setReleaseError({ id: row.id, text: e instanceof Error ? e.message : 'Release failed.' });
    } finally {
      setReleasing('');
    }
  };

  if (!f) {
    return (
      <div className="card">
        <h2>Finance</h2>
        <p className="hint">Escrow-wallet figures appear once the marketplace&apos;s ledger has entries — the first in-app payment creates them.</p>
      </div>
    );
  }

  const rows = d.payoutRows ?? [];
  const awaitingRelease = rows.filter((row) => row.status !== 'paid').length;
  const overspent = f.shippingBalanceCents < 0;

  return (
    <>
      <div className="card">
        <h2>Money at a glance</h2>
        <p className="hint">The escrow wallet in real time — every rand the marketplace holds, owes or has paid out, straight from the ledger.</p>
        <div className="grid">
          <div className="stat">
            <div className="label">Courier budget</div>
            <div className="value mono" style={overspent ? { color: 'var(--danger)' } : undefined}>{money(f.shippingBalanceCents)}</div>
            <div className="detail">{overspent
              ? 'Top up The Courier Guy wallet — bookings still work, but the budget is overspent'
              : 'The Courier Guy wallet — funded from buyer shipping fees'}</div>
          </div>
          <div className="stat"><div className="label">Held in escrow</div><div className="value mono">{money(f.escrowHeldCents)}</div><div className="detail">seller earnings waiting on delivery confirmation</div></div>
          <div className="stat"><div className="label">Payouts awaiting release</div><div className="value mono">{f.unreleasedPayouts}</div><div className="detail">release them in the queue below</div></div>
          <div className="stat">
            <div className="label">Engine</div>
            <div className="value">{engine ? <span className={engine.ggpayMode === 'live' ? 'pill ok' : 'pill warn'}>{engine.ggpayMode === 'live' ? 'Live' : 'Test mode'}</span> : '—'}</div>
            <div className="detail">{engine ? `${engine.feePercent}% platform fee per order` : 'in-app card engine'}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Wallet balances</h2>
        <p className="hint">Every non-zero wallet account, biggest first — buyers&apos; cash, commission, the courier budget and what has gone out.</p>
        {f.balances.length === 0 ? (
          <p className="muted small">No wallet activity yet — accounts appear as soon as money moves.</p>
        ) : (
          <div className="tablewrap" style={FINANCE_SCROLL}>
            <table>
              <thead><tr><th>Account</th><th>Balance</th></tr></thead>
              <tbody>
                {f.balances.map((b) => (
                  <tr key={`${b.kind}-${b.refId ?? ''}`}>
                    <td><strong>{b.label ?? b.kindLabel}</strong><div className="small muted">{b.kindLabel}{b.refId ? ` · ${b.refId}` : ''}</div></td>
                    <td className="mono" style={b.cents < 0 ? { color: 'var(--danger)' } : undefined}>{money(b.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Payout queue ({awaitingRelease} awaiting release)</h2>
        <p className="hint">Sellers are paid only once their escrow is released — automatically when the courier confirms delivery (48&nbsp;h), or by your Release button. After release, advance the EFT as in Payments &amp; payouts.</p>
        {rows.length === 0 ? (
          <p className="muted small">No payouts yet — the first in-app card payment creates one automatically.</p>
        ) : (
          <div className="tablewrap" style={FINANCE_SCROLL}>
            <table>
              <thead><tr><th>Payout</th><th>Order</th><th>Store</th><th>Net</th><th>Destination</th><th>Escrow</th><th>Actions</th></tr></thead>
              <tbody>
                {rows.map((row) => {
                  const inEscrow = row.status !== 'paid' && (row.held || !row.releasedAt);
                  return (
                    <tr key={row.id}>
                      <td className="mono small">{row.reference}</td>
                      <td className="mono small">{row.orderNumber}</td>
                      <td className="small">{row.storeName}</td>
                      <td className="mono">{money(row.netCents)}</td>
                      <td className="small">{row.destination}</td>
                      <td>
                        {row.status === 'paid'
                          ? <span className="pill muted">Paid</span>
                          : inEscrow
                            ? <span className="pill warn">In escrow</span>
                            : <span className="pill ok">Released</span>}
                        {inEscrow && row.orderStatus && <div className="small muted">order {row.orderStatus}</div>}
                      </td>
                      <td>
                        {row.status !== 'paid' && (
                          <div className="btnrow">
                            {inEscrow ? (
                              <button className="btn primary" data-testid="release-payout" disabled={busy !== '' || releasing !== ''} onClick={() => void release(row)}>
                                {releasing === row.id ? 'Releasing…' : 'Release'}
                              </button>
                            ) : (
                              <>
                                {row.status === 'pending' && <button className="btn" disabled={busy !== ''} onClick={() => void act('payout_status', row.id, 'processing')}>Mark processing</button>}
                                <button className="btn primary" disabled={busy !== ''} onClick={() => void act('payout_status', row.id, 'paid', `Mark payout ${row.reference} as PAID? Only do this once the EFT to ${row.destination} has actually gone out.`)}>Mark paid</button>
                              </>
                            )}
                          </div>
                        )}
                        {releaseError?.id === row.id && <div className="error-box" role="alert">{releaseError.text}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Ledger — newest movements ({f.recent.length})</h2>
        <p className="hint">Buyer cash in, seller earnings escrowed, commission taken, payouts, refunds and courier spend out. Newest first.</p>
        {f.recent.length === 0 ? (
          <p className="muted small">The ledger is empty — it fills in with the first in-app payment.</p>
        ) : (
          <div className="tablewrap" style={FINANCE_SCROLL}>
            <table>
              <thead><tr><th>When</th><th>Account</th><th>Amount</th><th>State</th><th>Ref</th><th>Memo</th></tr></thead>
              <tbody>
                {f.recent.map((e) => (
                  <tr key={e.id}>
                    <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtShort(e.at)}</td>
                    <td className="small">{ledgerKindLabel(e.kind)}{e.refId ? <div className="small muted">{e.refId}</div> : null}</td>
                    <td className="mono" style={{ color: e.direction === 'debit' ? 'var(--danger)' : 'var(--ok)', whiteSpace: 'nowrap' }}>
                      {e.direction === 'debit' ? '−' : '+'} {money(e.amountCents)}
                    </td>
                    <td><span className={ledgerStatePill(e.state)}>{e.state}</span></td>
                    <td className="small mono">{e.refType} {e.ref}</td>
                    <td className="small">{e.memo ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function InsightsPanel({ d }: { d: AdminData }) {
  const ins = d.insights;
  return (
    <>
      <div className="card">
        <h2>What shoppers search for</h2>
        {!ins ? <p className="hint">Insights appear once the marketplace has activity.</p> : (
          <>
            <p className="hint">Last {ins.windowDays} days · {ins.searchTotal} searches — real SearchLog rows, no sampling.</p>
            <h2 className="small muted">Top searches</h2>
            {ins.topSearches.length === 0 ? <p className="muted small">No searches yet — this fills in as shoppers use the search bar.</p> : <BarList rows={ins.topSearches} />}
            <h2 className="small muted mt14">Zero-result searches — real demand you cannot fulfil yet</h2>
            {ins.emptySearches.length === 0 ? <p className="muted small">Every search found something. 🎉</p> : (
              <>
                <BarList rows={ins.emptySearches} suffix="× no results" />
                <p className="small muted mt8">Tip: recruit sellers (or add stock) for these exact terms — they are shoppers you are losing today.</p>
              </>
            )}
          </>
        )}
      </div>
      <div className="card">
        <h2>Feature usage</h2>
        {!ins || ins.featureUsage.length === 0 ? <p className="hint">No feature activity yet — events are recorded as shoppers browse, save and review.</p> : (
          <>
            <p className="hint">Real behaviour events, last {ins.windowDays} days.</p>
            <BarList rows={ins.featureUsage.map((f) => ({ term: featureLabel(f.type), count: f.count }))} />
          </>
        )}
      </div>
    </>
  );
}

function Billing({ d }: { d: AdminData }) {
  const ins = d.insights;
  const calls = useMemo(() => new Map((ins?.apiUsage ?? []).map((a) => [a.service, a.calls])), [ins]);
  const services = ins?.services ?? {};
  return (
    <div className="card">
      <h2>API key usage &amp; billing</h2>
      <p className="hint">
        Actual outbound calls over the last {ins?.windowDays ?? 30} days, plus what each integration costs and where to pay.
        Key secrets are never shown — only whether each service is configured on the server.
      </p>
      {Object.entries(SERVICE_META).map(([key, meta]) => {
        const configured = key === 'geocode' ? true : Boolean(services[key]);
        const usage = calls.get(key) ?? 0;
        return (
          <div className="svc" key={key}>
            <div className="head">
              <span className="name">{meta.label}</span>
              <span className={configured ? 'pill ok' : 'pill warn'}>{configured ? 'configured' : 'not configured'}</span>
            </div>
            <div className="calls">{usage} calls</div>
            <p className="cost">{meta.cost}</p>
            <a href={meta.manage} target="_blank" rel="noopener noreferrer">Manage / pay at {meta.manageLabel} ↗</a>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subscriptions — who is on trial, who paid, who did not, free access
// ---------------------------------------------------------------------------

const STATE_LABEL: Record<BillingState, string> = {
  paid: 'paying', trial: 'free trial', expired: 'unpaid — paused', free: 'free access', not_active: 'not live',
};
const statePill = (st: BillingState) => (st === 'paid' || st === 'free' ? 'pill ok' : st === 'trial' ? 'pill warn' : st === 'expired' ? 'pill bad' : 'pill muted');

function Subscriptions({ d, act, busy, onMessage }: { d: AdminData; act: ActFn; busy: string; onMessage: (storeId: string) => void }) {
  const [filter, setFilter] = useState<'all' | BillingState>('all');
  const sub = d.subscriptions;
  if (!sub) return <div className="card"><p className="muted small">Subscription data is not available yet.</p></div>;
  const rows = sub.stores.filter((s) => filter === 'all' || s.state === filter);
  const filters: { key: 'all' | BillingState; label: string; n: number }[] = [
    { key: 'all', label: 'All', n: sub.stores.length },
    { key: 'expired', label: 'Unpaid', n: sub.summary.expired },
    { key: 'trial', label: 'Free trial', n: sub.summary.trial },
    { key: 'paid', label: 'Paying', n: sub.summary.paid },
    { key: 'free', label: 'Free access', n: sub.summary.free },
    { key: 'not_active', label: 'Not live', n: sub.summary.notActive },
  ];
  return (
    <>
      <div className="card">
        <h2>Seller subscriptions</h2>
        <p className="hint">{rands(sub.summary.priceMonthlyCents ?? 49900)} a month or {rands(sub.summary.priceYearlyCents ?? 699900)} a year, {sub.summary.trialDays ?? 30}-day free trial from approval. Unpaid stores are paused automatically — their store page and products are hidden until they pay. Every figure comes from confirmed Yoco payments.</p>
        {sub.summary.paymentsDetail && (
          <div className={sub.summary.paymentsOn ? 'ok-box' : 'error-box'} role="status" data-testid="payments-status">
            <strong>Card payments for subscriptions: {sub.summary.paymentsOn ? 'ON' : 'OFF'}</strong> — {sub.summary.paymentsDetail.replace(/^(ON|OFF) — /, '')}
          </div>
        )}
        <div className="grid">
          <div className="stat"><div className="label">Paying</div><div className="value mono">{sub.summary.paid}</div><div className="detail">active paid subscriptions</div></div>
          <div className="stat"><div className="label">Free trial</div><div className="value mono">{sub.summary.trial}</div><div className="detail">still in their 30 days</div></div>
          <div className="stat"><div className="label">Unpaid</div><div className="value mono">{sub.summary.expired}</div><div className="detail">paused until they pay</div></div>
          <div className="stat"><div className="label">Free access</div><div className="value mono">{sub.summary.free}</div><div className="detail">granted by you (incl. admin)</div></div>
          <div className="stat"><div className="label">This month</div><div className="value mono">{money(sub.summary.revenueThisMonthCents)}</div><div className="detail">{sub.summary.paymentsThisMonth} payment(s)</div></div>
          <div className="stat"><div className="label">Last 30 days</div><div className="value mono">{money(sub.summary.revenueLast30Cents)}</div><div className="detail">{sub.summary.paymentsLast30} payment(s)</div></div>
          <div className="stat"><div className="label">All time</div><div className="value mono">{money(sub.summary.revenueAllTimeCents)}</div><div className="detail">{sub.summary.paymentsAllTime} payment(s)</div></div>
        </div>
      </div>

      <div className="card">
        <h2>Stores</h2>
        <div className="btnrow" role="group" aria-label="Filter stores">
          {filters.map((f) => (
            <button key={f.key} className={filter === f.key ? 'btn primary' : 'btn'} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}>{f.label} ({f.n})</button>
          ))}
        </div>
        <div className="tablewrap mt14">
          <table>
            <thead><tr><th>Store</th><th>Status</th><th>Access until</th><th>Paid so far</th><th>Last payment</th><th>Actions</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="muted small">No stores in this group.</td></tr>}
              {rows.map((s) => (
                <tr key={s.id} data-testid="billing-row" data-store={s.slug}>
                  <td><strong>{s.name}</strong><div className="small muted">{s.ownerEmail}</div></td>
                  <td>
                    <span className={statePill(s.state)}>{STATE_LABEL[s.state]}</span>
                    {s.billingExemptNote && s.state === 'free' && <div className="small muted">{s.billingExemptNote}</div>}
                    {s.plan && s.state === 'paid' && <div className="small muted">{s.plan} plan</div>}
                  </td>
                  <td className="small">{s.accessUntil ? fmtDate(s.accessUntil) : '—'}{s.daysLeft !== null ? <div className="muted">{s.daysLeft} day(s) left</div> : null}</td>
                  <td className="mono">{money(s.totalPaidCents)}<div className="small muted">{s.paymentsCount} payment(s)</div></td>
                  <td className="small">{s.lastPaidAt ? fmtDate(s.lastPaidAt) : 'never'}</td>
                  <td>
                    <div className="btnrow">
                      {!s.billingExempt && (
                        <button className="btn primary" disabled={busy !== ''} onClick={() => {
                          const note = window.prompt(`Give "${s.name}" free access? Optional note (for example "partner store"):`, '');
                          if (note === null) return;
                          void act('billing_exempt', s.id, 'on', undefined, note.trim() ? { note: note.trim().slice(0, 200) } : undefined);
                        }}>Give free access</button>
                      )}
                      {s.billingExempt && !s.adminOwned && (
                        <button className="btn danger" disabled={busy !== ''} onClick={() => void act('billing_exempt', s.id, 'off', `Remove free access for "${s.name}"? If their trial and paid time are over, the store pauses until they pay.`)}>Remove free access</button>
                      )}
                      <button className="btn" onClick={() => onMessage(s.id)}>Message</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Subscription payments ({sub.payments.length} newest)</h2>
        <p className="hint">Paid = confirmed with Yoco by Green Gate&apos;s server. Being confirmed = the seller started paying; the daily job and the seller&apos;s dashboard re-check it. Cancelled = checkout not completed within 3 days.</p>
        <div className="tablewrap">
          <table>
            <thead><tr><th>Reference</th><th>Store</th><th>Plan</th><th>Amount</th><th>Status</th><th>Started</th><th>Paid</th><th>Covers until</th></tr></thead>
            <tbody>
              {sub.payments.length === 0 && <tr><td colSpan={8} className="muted small">No subscription payments yet.</td></tr>}
              {sub.payments.map((p) => (
                <tr key={p.id}>
                  <td className="mono small">{p.reference}</td>
                  <td>{p.storeName}</td>
                  <td className="small">{p.plan}</td>
                  <td className="mono">{money(p.amountCents)}</td>
                  <td><span className={p.status === 'paid' ? 'pill ok' : p.status === 'pending' ? 'pill warn' : 'pill muted'}>{p.status === 'pending' ? 'being confirmed' : p.status}</span></td>
                  <td className="small">{fmtWhen(p.createdAt)}</td>
                  <td className="small">{p.paidAt ? fmtWhen(p.paidAt) : '—'}</td>
                  <td className="small">{p.periodEnd ? fmtDate(p.periodEnd) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Messages — text conversations with sellers (one thread per store)
// ---------------------------------------------------------------------------

function Messages({ d, act, busy, selected, onSelect, onRefresh }: { d: AdminData; act: ActFn; busy: string; selected: string; onSelect: (storeId: string) => void; onRefresh: () => Promise<void> }) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const threads = useMemo(
    () => [...(d.messageThreads ?? [])].sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) || b.lastAt.localeCompare(a.lastAt)),
    [d.messageThreads],
  );
  const stores = d.subscriptions?.stores ?? [];
  const thread = threads.find((t) => t.storeId === selected);
  const storeName = thread?.storeName ?? stores.find((s) => s.id === selected)?.name ?? '';
  const markedRef = useRef('');

  const [refreshing, setRefreshing] = useState(false);
  // Opening a thread marks the seller's messages as read (quietly) — again
  // whenever a new reply arrives while it is open.
  useEffect(() => {
    const key = thread ? `${thread.storeId}:${thread.lastAt}` : '';
    if (thread && thread.unread > 0 && markedRef.current !== key) {
      markedRef.current = key;
      void act('mark_seller_messages_read', thread.storeId, undefined, undefined, undefined, true);
    }
  }, [thread, act]);
  // Follow the newest message (the list is capped at 100, so its length can stay the same).
  const newestId = thread?.messages[thread.messages.length - 1]?.id;
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [selected, newestId]);

  const send = async () => {
    const body = text.trim();
    if (!body || !selected) return;
    const ok = await act('send_seller_message', selected, undefined, undefined, { message: body.slice(0, 2000) }, true);
    if (ok) setText('');
  };

  return (
    <div className="card">
      <h2>Messages with sellers</h2>
      <p className="hint">Text only. Sellers see these in their dashboard (and get a notification); their replies appear here — this page checks for new ones every 15 seconds.</p>
      <div className="btnrow">
        <button className="btn" disabled={refreshing} onClick={() => { setRefreshing(true); void onRefresh().finally(() => setRefreshing(false)); }} data-testid="msg-refresh">
          {refreshing ? 'Checking…' : 'Check for new messages'}
        </button>
      </div>
      <div className="msg-layout">
        <div className="msg-threads">
          <label className="small muted" htmlFor="msg-new">Start or open a conversation</label>
          <select id="msg-new" className="msg-select" value={selected} onChange={(e) => onSelect(e.target.value)}>
            <option value="">Choose a store…</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.ownerEmail}</option>)}
          </select>
          <ul className="msg-list" aria-label="Conversations">
            {threads.length === 0 && <li className="muted small">No conversations yet.</li>}
            {threads.map((t) => (
              <li key={t.storeId}>
                <button className={t.storeId === selected ? 'msg-thread active' : 'msg-thread'} onClick={() => onSelect(t.storeId)}>
                  <span className="name">{t.storeName}{t.unread > 0 && <span className="pill warn"> {t.unread} new</span>}</span>
                  <span className="small muted">{t.messages[t.messages.length - 1]?.body.slice(0, 60)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="msg-pane">
          {!selected ? (
            <p className="muted small">Choose a store to read or start a conversation.</p>
          ) : (
            <>
              <h3 className="msg-title">{storeName}</h3>
              <div ref={listRef} className="msg-scroll" data-testid="admin-thread">
                {(thread?.messages ?? []).length === 0 && <p className="muted small">No messages yet — write the first one below.</p>}
                {(thread?.messages ?? []).map((m) => (
                  <div key={m.id} className={m.fromAdmin ? 'bubble mine' : 'bubble theirs'} data-testid={m.fromAdmin ? 'admin-msg' : 'seller-msg'}>
                    <p>{m.body}</p>
                    <span>{m.fromAdmin ? 'You (Green Gate)' : storeName} · {fmtWhen(m.createdAt)}</span>
                  </div>
                ))}
              </div>
              <label className="small muted" htmlFor="msg-text">Message to {storeName}</label>
              <textarea
                id="msg-text"
                className="msg-input"
                rows={3}
                maxLength={2000}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && busy === '') { e.preventDefault(); void send(); } }}
                placeholder="Write a message… (Ctrl+Enter sends)"
              />
              <div className="btnrow">
                <button className="btn primary" disabled={busy !== '' || !text.trim()} onClick={() => void send()} data-testid="admin-send">Send</button>
                <span className="small muted">{text.length}/2000</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Audit({ d }: { d: AdminData }) {
  return (
    <div className="card">
      <h2>Audit log ({d.auditLogs.length} newest)</h2>
      <p className="hint">Every admin action is recorded: who, what, when.</p>
      <div className="tablewrap">
        <table>
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
          <tbody>
            {d.auditLogs.map((a) => (
              <tr key={a.id}>
                <td className="small">{fmtWhen(a.createdAt)}</td>
                <td className="small">{a.actorEmail ?? '—'}</td>
                <td className="small"><span className="pill muted">{a.action}</span></td>
                <td className="small mono">{a.target ?? '—'}</td>
                <td className="small">{a.detail ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// System monitor — live every-second health view (additive)
// ---------------------------------------------------------------------------

interface MonitorCheck { service: string; ok: boolean; detail: string }
interface MonitorIncident {
  check: string; detail: string; occurrences: number;
  openedAt: string; lastSeenAt: string; resolvedAt: string | null; openMinutes: number;
}
interface MonitorData {
  status: string;
  time: string;
  latencyMs: number;
  checks: MonitorCheck[];
  incidents: { open: MonitorIncident[]; recentResolved: MonitorIncident[] };
  payments?: { paid: number; failed: number; successRatePct: number | null; volumeCents: number };
  payouts?: { pending: { count: number; netCents: number }; processing: { count: number; netCents: number }; paid: { count: number; netCents: number }; feePercent: string };
  paymentEngine?: { ggpayMode: string };
  queue?: { pendingStores: number; pendingProducts: number; awaitingPayment: number };
  error?: string;
}

function SystemMonitor({ onSignedOut }: { onSignedOut: () => void }) {
  const [m, setM] = useState<MonitorData | null>(null);
  const [err, setErr] = useState('');
  const [ticks, setTicks] = useState(0);
  const [paused, setPaused] = useState(false);
  // One pull at a time: when the marketplace is slow, the 1-second timer must
  // not stack overlapping deep-check requests onto it.
  const inFlight = useRef(false);
  const signedOut = useRef(onSignedOut);
  useEffect(() => { signedOut.current = onSignedOut; }, [onSignedOut]);

  useEffect(() => {
    if (paused) return;
    let alive = true;
    const pull = async () => {
      // Every second while you are looking; nothing while the tab is hidden
      // (each pull runs the marketplace's deep checks — a forgotten
      // background tab must not run them 86,400 times a day).
      if (document.hidden || inFlight.current) return;
      inFlight.current = true;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      try {
        const res = await fetch('/api/console/monitor', { cache: 'no-store', signal: ctrl.signal });
        if (res.status === 401) {
          if (alive) signedOut.current(); // session expired — back to the sign-in card
          return;
        }
        const json = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as MonitorData;
        if (!alive) return;
        if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
        setM(json);
        setErr('');
        setTicks((t) => t + 1);
      } catch (e) {
        if (!alive) return;
        const aborted = e instanceof Error && e.name === 'AbortError';
        setErr(aborted ? 'The marketplace took too long to answer.' : e instanceof Error ? e.message : 'Monitor unreachable.');
      } finally {
        clearTimeout(timer);
        inFlight.current = false;
      }
    };
    void pull();
    const iv = setInterval(pull, 1000); // every single second while the tab is visible
    const onVisible = () => { if (!document.hidden) void pull(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; clearInterval(iv); document.removeEventListener('visibilitychange', onVisible); };
  }, [paused]);

  const allOk = m ? m.checks.every((c) => c.ok) && m.incidents.open.length === 0 : false;

  return (
    <div className="card" aria-live="polite">
      <h2>System monitor</h2>
      <p className="hint">
        Live health of every marketplace system — this view re-checks the real database and service configuration
        every second while it is open. The background check (/api/cron/system-watch) records incidents and emails you
        when something fails and again when it recovers — Vercel runs it once a day on the Hobby plan; point an uptime
        pinger at it every minute (or move to Pro) for around-the-clock coverage.
      </p>

      <div className="svc">
        <div className="head">
          <span className="name">
            {err ? 'MONITOR UNREACHABLE' : allOk ? 'ALL SYSTEMS OPERATIONAL' : 'ATTENTION NEEDED'}
          </span>
          <span className={err ? 'pill bad' : allOk ? 'pill ok' : 'pill warn'}>
            {err ? 'offline' : allOk ? 'healthy' : 'degraded'}
          </span>
        </div>
        <div className="calls">
          {err ? `last good data ${m ? '— reconnecting…' : 'none yet'}` : `checked ${ticks} time(s) · server time ${m?.time ?? '—'} · db latency ${m?.latencyMs ?? '—'} ms`}
        </div>
        <p className="cost">
          Polling: {paused ? 'paused' : 'every second'}{' '}
          <button className="btn" onClick={() => setPaused((p) => !p)}>{paused ? 'Resume' : 'Pause'}</button>
        </p>
      </div>

      {err && <div className="error-box" role="alert">{err} — the marketplace may be restarting; retrying automatically.</div>}

      {m && (
        <>
          <div className="tablewrap">
            <table>
              <thead><tr><th>System</th><th>Status</th><th>Detail</th></tr></thead>
              <tbody>
                {m.checks.map((c) => (
                  <tr key={c.service}>
                    <td>{c.service}</td>
                    <td><span className={c.ok ? 'pill ok' : 'pill bad'}>{c.ok ? 'ok' : 'failing'}</span></td>
                    <td>{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {m.incidents.open.length > 0 && (
            <>
              <h3 className="mt14">Open incidents</h3>
              <div className="tablewrap">
                <table>
                  <thead><tr><th>Check</th><th>Failed runs</th><th>Open for</th><th>Detail</th></tr></thead>
                  <tbody>
                    {m.incidents.open.map((i) => (
                      <tr key={i.check}>
                        <td>{i.check}</td>
                        <td>{i.occurrences}</td>
                        <td>{i.openMinutes} min</td>
                        <td>{i.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {m.incidents.recentResolved.length > 0 && (
            <>
              <h3 className="mt14">Recently recovered</h3>
              <div className="tablewrap">
                <table>
                  <thead><tr><th>Check</th><th>Duration</th><th>Detail</th></tr></thead>
                  <tbody>
                    {m.incidents.recentResolved.map((i) => (
                      <tr key={`${i.check}-${i.resolvedAt}`}>
                        <td>{i.check}</td>
                        <td>{i.openMinutes} min</td>
                        <td>{i.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {m.queue && (
            <>
              <h3 className="mt14">Work queues</h3>
              <div className="kpis">
                <div className="kpi"><span className="num">{m.queue.pendingStores}</span><span className="lbl">Store applications waiting</span></div>
                <div className="kpi"><span className="num">{m.queue.pendingProducts}</span><span className="lbl">Products awaiting approval</span></div>
                <div className="kpi"><span className="num">{m.queue.awaitingPayment}</span><span className="lbl">Orders awaiting payment</span></div>
              </div>
            </>
          )}

          {m.payments && (
            <>
              <h3 className="mt14">Money vitals</h3>
              <div className="kpis">
                <div className="kpi"><span className="num">{m.payments.paid}</span><span className="lbl">Payments settled</span></div>
                <div className="kpi"><span className="num">{m.payments.failed}</span><span className="lbl">Declines recorded</span></div>
                <div className="kpi"><span className="num">{m.payments.successRatePct === null ? '—' : `${m.payments.successRatePct}%`}</span><span className="lbl">Success rate</span></div>
                <div className="kpi"><span className="num">{m.payouts?.pending.count ?? 0}</span><span className="lbl">Payouts queued</span></div>
              </div>
              <p className="small muted mt8">
                In-app card engine: {m.paymentEngine?.ggpayMode === 'live' ? 'acquirer key set, every card refused until an acquirer is connected' : 'off on the live site (card form hidden, every card refused)'}. Sellers&apos; own Yoco / PayFast / Ozow rails move real money.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
