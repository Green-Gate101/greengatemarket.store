'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

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

type TabKey = 'overview' | 'stores' | 'orders' | 'users' | 'insights' | 'billing' | 'audit';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'stores', label: 'Stores' },
  { key: 'orders', label: 'Orders' },
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
            {tab === 'stores' && <Stores d={data} act={act} busy={busy} />}
            {tab === 'orders' && <Orders d={data} act={act} busy={busy} />}
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
        <a className="btn" href="https://www.greengatemarket.store" target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>Open storefront ↗</a>
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
          <div className="stat"><div className="label">Awaiting payment</div><div className="value mono">{d.orders.pendingPayment}</div><div className="detail">confirm after EFT / proof of payment</div></div>
        </div>
      </div>
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
                    {s.status === 'pending' && (
                      <>
                        <button className="btn primary" disabled={busy !== ''} onClick={() => void act('store_status', s.id, 'approve')}>Approve</button>
                        <button className="btn danger" disabled={busy !== ''} onClick={() => void act('store_status', s.id, 'decline')}>Decline</button>
                      </>
                    )}
                    {s.status === 'active' && (
                      <button className="btn danger" disabled={busy !== ''} onClick={() => void act('store_status', s.id, 'suspend', `Suspend "${s.name}"? Its listings will be hidden until reinstated.`)}>Suspend</button>
                    )}
                    {s.status === 'suspended' && (
                      <button className="btn primary" disabled={busy !== ''} onClick={() => void act('store_status', s.id, 'reinstate')}>Reinstate</button>
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

function BarList({ rows, suffix }: { rows: { term: string; count: number }[]; suffix?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div>
      {rows.map((r) => (
        <div className="bar-row" key={r.term}>
          <span className="term">{r.term}</span>
          <span className="bar"><i style={{ width: `${Math.max(6, Math.round((r.count / max) * 100))}%` }} /></span>
          <span className="count">{r.count}{suffix ?? ''}</span>
        </div>
      ))}
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
