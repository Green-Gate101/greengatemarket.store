# CLAUDE.md — Green Gate Admin Console

Guidance for AI coding agents (Claude Code and friends) working on this repository.

## What this is

The **standalone Admin Console** for the Green Gate marketplace (admin.greengatemarket.store).
It is a thin, server-side-only client over the marketplace's admin APIs — it owns **no
database and no secrets of its own**. All data is fetched from the marketplace
(greengatemarket.store) with the marketplace admin session attached server-side.

- **Marketplace repo** (storefront + API): `Green-Gate101/greengatemarket.store` — its
  root `CLAUDE.md` is the master handbook (architecture facts, payment rules, E2E
  patterns). Read it first; it explains every system this console reports on.
- **This repo**: one page (`src/app/page.tsx`) + five proxy routes
  (`src/app/api/console/{login,logout,data,action,monitor}/route.ts`).

## How it works (will bite you if ignored)

1. **The browser never talks to the marketplace.** Every call goes through this app's
   own `/api/console/*` proxy, which attaches the parked marketplace session cookie
   (`gg_admin_sess`) server-side. `MAIN_SITE_URL` points at the marketplace
   (default `https://greengatemarket.store`).
2. **Login** (`/api/console/login`) posts the email + password to the marketplace's
   NextAuth credentials flow, parks the resulting session server-side against a
   random console-side session id, and sets that id as the `gg_admin_sess` cookie.
   Rate-limited separately (10 / 5 min).
3. **The marketplace re-enforces ADMIN on every request** (`requireRole('ADMIN')`
   re-verifies the role against the database) — this proxy adds no authority. A
   non-admin session gets 403 through the proxy exactly as it would directly.
4. **`/api/console/action`** forwards admin actions (approve/decline store
   applications, moderate products, confirm payments, ban/unban, delete order/user,
   payouts) to `POST /api/admin`. Money rules live on the marketplace side —
   e.g. paid orders can never be deleted (409), payment confirmation is an atomic
   claim — do not try to re-implement or bypass them here.
5. **System monitor tab** polls `/api/console/monitor` (→ marketplace `/api/monitor`)
   **every second** while the tab is visible (paused while hidden, refreshed on return). That endpoint runs the marketplace's deep checks AND
   feeds the shared incident state machine (`MonitorIncident` rows + admin emails),
   so per-second human watching is recorded the same way the background cron is.
   Background coverage: `/api/cron/system-watch` on the marketplace (Vercel Cron).
6. **Cross-site guard**: `login`, `logout` and `action` refuse requests a browser marks
   as not same-origin (`src/app/api/console/same-origin.ts`) — the storefront shares the
   site with the console, so SameSite=Lax alone would still attach the admin cookie to
   forged storefront POSTs. `next.config.ts` sends `X-Frame-Options: DENY` /
   `frame-ancestors 'none'` (no clickjacking on destructive actions).
7. All figures are live from the marketplace database — no sampling, no placeholders,
   no fake states. Keep it that way (project owner's standing rule: nothing fake).

## Commands

- `bun install` then `bunx tsc --noEmit` (typecheck — there is no separate build check here).
- Local dev: set `MAIN_SITE_URL` (e.g. `http://localhost:3000` for a local marketplace)
  and run `bun run dev`.
- Deployment: Vercel project `greengate-admin-console`, Git-connected to this repo's
  `main` — every push deploys.

## House rules (project owner's standing directives)

- **English only**, everywhere, always.
- **Never break working code; additive changes only.** No rewrites of functioning systems.
- **Nothing fake** — honest error states, live figures only.
- Ship in lockstep with the marketplace repo: a console change that depends on a new
  marketplace endpoint must land after (or with) the marketplace commit.
- Never commit tokens, `.env*`, or session material.
