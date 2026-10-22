# CLAUDE.md — Green Gate Marketplace

Guidance for AI coding agents (Claude Code and friends) working on this repository.

## What this is

**Green Gate Marketplace** (greengatemarket.store) — a production South-African
marketplace (Amazon/Takealot model): buyers check out in-app, sellers own stores,
the marketplace is merchant-of-record for in-app card payments and pays sellers
out automatically less a 5% platform fee.

Two apps live in this repository:

| App | Location | Domain | Deployment |
|---|---|---|---|
| Storefront + API | repo root (`src/`) | greengatemarket.store | Vercel project, Git-connected to `Green-Gate101/greengatemarket.store` (main) |
| Admin console | `admin-console/` | admin.greengatemarket.store | Vercel project `greengate-admin-console`, Git-connected to its own repo `Green-Gate101/greengate-admin-console` (the subtree is pushed there), manual fallback: `VERCEL_TOKEN=… node scripts/deploy-admin-rest.mjs` |

## Stack & commands

- Next.js 16 (App Router) + TypeScript 5 + React 19, Tailwind 4 + shadcn/ui (New York), Prisma 6 + **SQLite**, NextAuth v4 (credentials + Google), sharp, zod.
- **Storefront**: `bun run dev` (port 3000, logs tee to `dev.log`), `bun run lint`, `bunx tsc --noEmit`, `bun run db:push` (schema in `prisma/schema.prisma`, local DB file `db/custom.db`).
- **Admin console**: own `package.json` — run `bun install` inside `admin-console/` first; then `bunx tsc --noEmit` there. It is a thin server-side auth proxy: it never talks to the DB, it proxies to the marketplace admin API with a parked session cookie.
- Prisma client is generated for SQLite locally. Postgres variants exist (`prisma/schema.postgres.prisma`, `scripts/switch-neon.sh`) but the running setup is SQLite; on Vercel `scripts/prepare-db.sh` applies the schema at build. If a fresh process can't find tables, run `bunx prisma generate` then `bun run db:push`.

## Architecture facts that will bite you if ignored

1. **The user-visible site is a single route (`src/app/page.tsx`) with hash-based SPA routing** (`#/product/<slug>`, `#/dashboard`, …) driven by `useSyncExternalStore` in `src/components/greengate/app-shell.tsx`. Do not introduce new Next.js routes for screens; extend `parseHash` + the view map. Components live in `src/components/greengate/`.
2. **Never trust the client.** All pricing is recomputed server-side from the DB; roles are re-verified from the DB on every privileged call (`requireUser` / `requireRole` in `src/lib/auth.ts`); images are validated by magic bytes; product photos pass the AI guard (`src/lib/ai-image-guard.ts`) and the white-background studio pipeline (`src/lib/image-processing.ts` — flood-fill background removal, then composite on a white square canvas; it never fails a listing: on any processing error the normalised original ships).
3. **Money is integer cents everywhere** (`priceCents`, `totalCents = subtotalCents + shippingCents`). Fee math: `Math.round((gross * pct) / 100)`.
4. **All payment paths funnel through `settleOrderPayment()` in `src/lib/ggpay.ts`** — the single choke-point that marks an order paid (atomic conditional `updateMany` claim; cancelled/refunded orders can never be settled). Marketplace rails (GGPay card, marketplace PayFast, bank transfer) queue a Payout (gross − 5% fee). **Seller-owned rails (`payfast_seller`, `ozow`) must NOT queue a payout** — the money already went to the seller's own gateway account (same for seller-owned Yoco, which has its own confirm path in `src/lib/yoco.ts`).
5. **Checkout idempotency**: multi-seller carts split into one order per store; the idempotency key is stored per order as `<key>:<storeId>`. Duplicate lookups are buyer-scoped and return a whitelisted projection (encrypted processor keys are NEVER returned by any API).
6. **Webhooks fail closed**: PayFast ITN (md5 + passphrase REQUIRED — refuse processing when unset), Ozow notify (SHA-512 hash) plus an authenticated status query that ALSO checks amount + reference against the order. Post-verification failures return 5xx (providers retry); pre-verification rejections return 200 (permanent).
7. **Only ACTIVE stores sell**: catalogue, product detail, recommendations, cart, wishlist and checkout all filter `store.status === 'active'`. Admin moderation stands — a seller cannot re-approve a product that has a `moderationNote`.
8. **Secrets** (seller PayFast/Ozow/Yoco keys) are AES-256-GCM encrypted (`src/lib/secret-box.ts`, key derived from `NEXTAUTH_SECRET` — fails closed in production if unset) and are write-only through the API.
9. Rate limiting is in-process (`src/lib/rate-limit.ts`) — acceptable for single-instance; don't rely on it across instances.

## Environment variables (Vercel production)

`DATABASE_URL`, `NEXTAUTH_SECRET` (required — secret-box and sessions fail closed without it), `ADMIN_EMAIL`, `ADMIN_PASSWORD`. Optional integrations: `ALGOLIA_*`, `RESEND_API_KEY`/`RESEND_FROM`, `COURIER_GUY_API_KEY`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `PAYFAST_MERCHANT_ID`/`PAYFAST_MERCHANT_KEY`/`PAYFAST_PASSPHRASE` (all three required for the marketplace PayFast rail), `PAYFAST_SANDBOX=1`, `OZOW_IS_TEST` (production defaults to LIVE; dev/preview default to test), `GGPAY_ACQUIRER_KEY` (routes the in-app card charge to a real acquirer — sandbox otherwise), `GG_PLATFORM_FEE_PERCENT` (default 5).

## House rules (project owner's standing directives)

- **English only**, everywhere, always.
- **Never break working code; additive changes only.** No rewrites of functioning systems.
- **Nothing fake**: no seeded/fake data, no fake payment approvals, honest error messages (a rejected card is a rejected card; a sandbox charge is disclosed as sandbox).
- No second-hand clothing/footwear listings; no replicas/counterfeits.
- Every change ships to **both apps in lockstep**: commit → push GitHub main (storefront) → push the `admin-console/` subtree to its repo (or REST-deploy it) → verify BOTH domains serve the new build.
- `worklog.md` and `.env` are git-ignored; never commit tokens.
- Check `dev.log` (tail) for runtime errors after changes; lint + `tsc --noEmit` on BOTH apps before any deploy.

## E2E testing patterns that work here

- NextAuth credentials flow with cookie jars: GET `/api/auth/csrf` → POST `/api/auth/callback/credentials` (form-urlencoded). See `scripts/e2e-seller-flow.mjs` for the working harness (jars, multipart, the full seller questionnaire field list).
- GGPay sandbox test card: `4242424242424242`, any future `MM/YY`, any 3-digit CVV. Declines: tail `0002` (bank decline), `9995` (insufficient funds), `0069` (fraud flag).
- Store applications start `pending` — products require an `active` store (admin approves, or activate directly in the local DB for tests).
- Registering accounts is rate-limited (5/h/IP) — reuse fixed identities for re-runs.
- The admin console's own login route is rate-limited separately (10/5min).
