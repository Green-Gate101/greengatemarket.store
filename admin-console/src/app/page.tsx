'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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
  productCount: number; createdAt: string;
}
interface AdminOrder {
  id: string; number: string; status: string; paymentStatus: string;
  buyerName: string; buyerEmail: string; totalCents: number; createdAt: string;
  store?: { name?: string };
}
interface AdminApplication {
  id: string; slug: string; name: string; email?: string; location?: string;
  createdAt: string; owner?: { email?: string; name?: string };
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
    feePercent: number;
  };
  paymentEngine?: { ggpayMode: 'test' | 'live'; feePercent: number };
  applications: AdminApplication[];
  auditLogs: AdminAudit[];
  categories?: { id: string; name: string; slug: string }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const money = (cents: number) => {
  try {
    return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', minimumFractionDigits: 2 }).format((cents ?? 0) / 100);
  } catch { return `R ${((cents ?? 0) / 100).toFixed(2)}`; }
};
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
const featureLabel = (t: string) => FEATURE_LABELS[t] ?? t.replaceAll('_', ' ');

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
    label: 'The Courier Guy — live shipping rates & labels',
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

type TabKey = 'overview' | 'monitor' | 'stores' | 'orders' | 'money' | 'users' | 'insights' | 'billing' | 'audit';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'monitor', label: 'System monitor' },
  { key: 'stores', label: 'Stores' },
  { key: 'orders', label: 'Orders' },
  { key: 'money', label: 'Payments & payouts' },
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
  const [tab, setTab] = useState<TabKey>('overview');
  const [busy, setBusy] = useState('');
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const res = await fetch('/api/console/data', { cache: 'no-store' });
      if (res.status === 401) { setAuthed(false); setData(null); return; }
      const json = (await res.json()) as AdminData & { error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
      setAuthed(true);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the dashboard.');
    }
  }, []);

  useEffect(() => { void load().finally(() => setChecking(false)); }, [load]);

  const act = useCallback(async (action: string, targetId: string, value?: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(action + targetId);
    setFlash(null);
    try {
      const res = await fetch('/api/console/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value === undefined ? { action, targetId } : { action, targetId, value }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean };
      if (res.status === 401) { setAuthed(false); setFlash({ kind: 'err', text: 'Session expired — sign in again.' }); return; }
      if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
      setFlash({ kind: 'ok', text: 'Done.' });
      await load();
    } catch (e) {
      setFlash({ kind: 'err', text: e instanceof Error ? e.message : 'Action failed.' });
    } finally {
      setBusy('');
    }
  }, [load]);

  const logout = useCallback(async () => {
    await fetch('/api/console/logout', { method: 'POST' });
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
              {t.label}
            </button>
          ))}
        </nav>

        {flash && <div className={flash.kind === 'ok' ? 'ok-box' : 'error-box'} role="status">{flash.text}</div>}
        {loadError && <div className="error-box" role="alert">{loadError} <button className="btn" onClick={() => void load()}>Retry</button></div>}
        {!data ? <p className="muted mt14">Loading dashboard…</p> : (
          <>
            {tab === 'overview' && <Overview d={data} />}
            {tab === 'monitor' && <SystemMonitor />}
            {tab === 'stores' && <Stores d={data} act={act} busy={busy} />}
            {tab === 'orders' && <Orders d={data} act={act} busy={busy} />}
            {tab === 'money' && <Money d={data} act={act} busy={busy} />}
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

function Overview({ d }: { d: AdminData }) {
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
            <div className="stat"><div className="label">Payouts owed</div><div className="value mono">{money(d.payouts.pending.netCents + d.payouts.processing.netCents)}</div><div className="detail">{d.payouts.pending.count} pending · {d.payouts.processing.count} processing</div></div>
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
              <thead><tr><th>Store</th><th>Owner</th><th>Location</th><th>Applied</th></tr></thead>
              <tbody>
                {d.applications.map((a) => (
                  <tr key={a.id}>
                    <td><strong>{a.name}</strong><div className="small muted">/{a.slug}</div></td>
                    <td className="small">{a.owner?.email ?? '—'}</td>
                    <td className="small">{a.location ?? '—'}</td>
                    <td className="small">{fmtDate(a.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted mt8">Approve or decline these in the <strong>Stores</strong> tab.</p>
        </div>
      )}
    </>
  );
}

interface ActFn {
  (action: string, targetId: string, value?: string, confirmText?: string): Promise<void>;
}

function Stores({ d, act, busy }: { d: AdminData; act: ActFn; busy: string }) {
  return (
    <div className="card">
      <h2>Stores ({d.stores.length})</h2>
      <p className="hint">Approve applications, suspend or reinstate stores. Suspending a store hides its listings but never deletes the business.</p>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Store</th><th>Owner</th><th>Status</th><th>Products</th><th>Joined</th><th>Actions</th></tr></thead>
          <tbody>
            {d.stores.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong><div className="small muted">/{s.slug}</div></td>
                <td className="small">{s.email}</td>
                <td><span className={pillClass(s.status)}>{s.status}</span></td>
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

function Orders({ d, act, busy }: { d: AdminData; act: ActFn; busy: string }) {
  return (
    <div className="card">
      <h2>Recent orders ({d.orders.recent.length} newest)</h2>
      <p className="hint">Confirm payments once the money has cleared. Only delete test or junk records — real customer orders should be kept.</p>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Order</th><th>Buyer</th><th>Store</th><th>Total</th><th>Payment</th><th>Status</th><th>Placed</th><th>Actions</th></tr></thead>
          <tbody>
            {d.orders.recent.map((o) => (
              <tr key={o.id}>
                <td className="mono small">{o.number}</td>
                <td className="small">{o.buyerName}<div className="muted">{o.buyerEmail}</div></td>
                <td className="small">{o.store?.name ?? '—'}</td>
                <td className="mono">{money(o.totalCents)}</td>
                <td><span className={pillClass(o.paymentStatus)}>{o.paymentStatus}</span></td>
                <td><span className={pillClass(o.status)}>{ORDER_STATUS[o.status] ?? o.status}</span></td>
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
              ? 'GGPay card engine: LIVE acquirer connected — real cards are charged and real money moves.'
              : 'GGPay card engine: TEST MODE — only published sandbox test cards (e.g. 4242 4242 4242 4242) are approved; real cards are refused so no buyer can “pay” without money actually moving. Add a production acquirer key (GGPAY_ACQUIRER_KEY env var) to charge real cards. Seller-owned Yoco / PayFast / Ozow rails are always real.'}
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
  const rows = (d as unknown as { payoutRows?: { id: string; reference: string; orderNumber: string; storeName: string; netCents: number; destination: string; status: string; createdAt: string }[] }).payoutRows ?? [];
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
              <td><span className={pillClass(row.status === 'paid' ? 'paid' : row.status === 'processing' ? 'pending_payment' : 'awaiting_payment')}>{row.status}</span></td>
              <td>
                <div className="btnrow">
                  {row.status === 'pending' && <button className="btn" disabled={busy !== ''} onClick={() => void act('payout_status', row.id, 'processing')}>Mark processing</button>}
                  {row.status !== 'paid' && <button className="btn primary" disabled={busy !== ''} onClick={() => void act('payout_status', row.id, 'paid', `Mark payout ${row.reference} as PAID? Only do this once the EFT to ${row.destination} has actually gone out.`)}>Mark paid</button>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

function SystemMonitor() {
  const [m, setM] = useState<MonitorData | null>(null);
  const [err, setErr] = useState('');
  const [ticks, setTicks] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    let alive = true;
    const pull = async () => {
      try {
        const res = await fetch('/api/console/monitor', { cache: 'no-store' });
        const json = (await res.json()) as MonitorData;
        if (!alive) return;
        if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
        setM(json);
        setErr('');
        setTicks((t) => t + 1);
      } catch (e) {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : 'Monitor unreachable.');
      }
    };
    void pull();
    const iv = setInterval(pull, 1000); // every single second while the tab is open
    return () => { alive = false; clearInterval(iv); };
  }, [paused]);

  const allOk = m ? m.checks.every((c) => c.ok) && m.incidents.open.length === 0 : false;

  return (
    <div className="card" aria-live="polite">
      <h2>System monitor</h2>
      <p className="hint">
        Live health of every marketplace system — this view re-checks the real database and service configuration
        every second while it is open. A background cron (/api/cron/system-watch, every minute on Vercel) records
        incidents around the clock and emails you the moment something fails and again when it recovers.
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
                In-app card engine: {m.paymentEngine?.ggpayMode === 'live' ? 'live credential present (charges refused until the acquirer is wired)' : 'test mode — sandbox cards only'}. Sellers&apos; own Yoco / PayFast / Ozow rails move real money.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
