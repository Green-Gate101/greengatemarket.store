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
3. **Money is integer cents everywhere** (`priceCents`, `totalCents = subtotalCents + shippingCents`). Fee math: `Math.round((gross * pct) / 100)`. **Shipping is quoted PER STORE** at checkout (each seller's own origin + parcels; a multi-seller cart charges each order its own leg — never the first store's rate). Every outbound fetch has a hard timeout: Algolia 4s (search falls back to the DB on failure/empty), Resend 12s, Yoco 12s, Courier Guy 6.5s, geocoders 5–6s — keep it that way; nothing external may hang a request path.
4. **All payment paths funnel through `settleOrderPayment()` in `src/lib/ggpay.ts`** — the single choke-point that marks an order paid (atomic conditional `updateMany` claim; cancelled/refunded orders can never be settled). Marketplace rails (GGPay card, marketplace PayFast, bank transfer) queue a Payout (gross − 5% fee). **Seller-owned rails (`payfast_seller`, `ozow`) must NOT queue a payout** — the money already went to the seller's own gateway account (same for seller-owned Yoco, which has its own confirm path in `src/lib/yoco.ts`).
5. **In-app GGPay engine mode**: `ggpayEngineMode()` is `test` without `GGPAY_ACQUIRER_KEY` (sandbox cards only; real cards refused honestly) and `live` with it — but `live` **hard-refuses every charge** until the production routing hook in `chargeCard()` (src/lib/ggpay.ts) actually wires an acquirer. A credential alone never moves money; nothing may ever "approve" a card without a real charge. Do not remove this guard.
6. **Webhook binding rules (do not weaken)**: PayFast seller-mode ITN must match BOTH the seller's passphrase signature AND `merchant_id` AND `order.storeId === store.id`; Ozow notify stamps `ozowTransactionId` only AFTER positive proof; Yoco webhook/return only trust the checkout id stored on the order (never the payload's) and require the retrieved checkout's `amountCents === order.totalCents` (fail closed when Yoco reports no amount).
7. **Only ACTIVE stores sell**: catalogue, product detail, recommendations, cart, wishlist and checkout all filter `store.status === 'active'`. Admin moderation stands — a seller cannot re-approve a product that has a `moderationNote`.
8. **Multi-store checkout partial failure**: stores processed before a stock conflict keep their orders; the 201 response carries `partialFailure` so the buyer is told honestly what succeeded. The in-app cart/checkout lives in `#/checkout` (AccountView `initialTab="checkout"`) — there is NO `/checkout/pay` route; recovery links point to `/#/orders`.
9. **Secrets** (seller PayFast/Ozow/Yoco keys) are AES-256-GCM encrypted (`src/lib/secret-box.ts`, key derived from `NEXTAUTH_SECRET` — fails closed in production if unset) and are write-only through the API.
10. Rate limiting is in-process (`src/lib/rate-limit.ts`) — acceptable for single-instance; don't rely on it across instances. Credentials login is limited 10/15min per email+IP inside `authorize` (locked-out attackers see the generic wrong-password response). Public webhooks (PayFast ITN, Ozow notify, Yoco webhook/return) each carry a per-IP ceiling.
11. **Always-on monitor**: `/api/cron/system-watch` (Vercel Cron — scheduled daily in `vercel.json` because the team is on the Hobby plan, which only executes crons once/day; for around-the-clock coverage point an external pinger (UptimeRobot / cron-job.org) at the URL every minute with `Authorization: Bearer <CRON_SECRET>`, or upgrade to Pro and set the schedule to `* * * * *`) runs deep checks (db latency, stuck payment claims, rails posture, live Algolia probe every 5th run, email/Google drift), opens/closes `MonitorIncident` rows, and emails `ADMIN_EMAIL` exactly once per incident + once on recovery (`sendSystemAlertEmail`). `/api/monitor` (admin-only) runs the same incident machine on every pull and surfaces checks + incidents; the admin console's **System monitor** tab polls it every second. Do not remove the cron when testing — it is the uptime record.
12. **Financial records are forever**: `admin delete_user` AND `admin delete_order` refuse (409) when money trails are involved (paid orders; delete_order also cannot destroy a paid order's Payment/Payout cascade) — suspend (ban) instead. `confirm_payment` is an atomic guarded `updateMany` claim — concurrent confirms cannot double-fire. Admin POST carries a 120/min per-admin burst limit.

## Environment variables (Vercel production)

`DATABASE_URL`, `NEXTAUTH_SECRET` (required — secret-box and sessions fail closed without it), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `CRON_SECRET` (authenticates Vercel Cron → `/api/cron/*`; set it or the recovery/system-watch routes stay open). Optional integrations: `ALGOLIA_*`, `RESEND_API_KEY`/`RESEND_FROM`, `COURIER_GUY_API_KEY`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `PAYFAST_MERCHANT_ID`/`PAYFAST_MERCHANT_KEY`/`PAYFAST_PASSPHRASE` (all three required for the marketplace PayFast rail), `PAYFAST_SANDBOX=1`, `OZOW_IS_TEST` (production defaults to LIVE; dev/preview default to test), `GGPAY_ACQUIRER_KEY` (present ⇒ live mode; charges stay refused until the acquirer hook is wired — see fact 5), `GG_PLATFORM_FEE_PERCENT` (default 5).

## Scale path (10M buyers/sellers)
The data model carries hot-path composites (`[status, createdAt]`, `[status, categoryId]`, plus Order `yocoCheckoutId`, `[status, paymentStatus, createdAt]`, OrderItem `productId`, Store `status`) and `prisma/schema.postgres.prisma` mirrors every index — the Postgres escape hatch (`scripts/switch-neon.sh`, `BUILD_DB_MODE=postgres`, `POSTGRES_PRISMA_URL`) is built and untested-in-anger. Before 10M: move DATABASE_URL to Postgres/Neon, move the rate limiter behind Redis/Upstash (same interface in `src/lib/rate-limit.ts`), offload product images to the existing S3 path (`src/lib/storage.ts`), and put search-candidate caps + seller analytics aggregation on a queue.

## House rules (project owner's standing directives)

- **English only**, everywhere, always.
- **Never break working code; additive changes only.** No rewrites of functioning systems.
- **Nothing fake**: no seeded/fake data, no fake payment approvals, honest error messages (a rejected card is a rejected card; a sandbox charge is disclosed as sandbox).
- No second-hand clothing/footwear listings; no replicas/counterfeits.
- Every change ships to **both apps in lockstep**: commit → push GitHub main (storefront) → push the `admin-console/` subtree to its repo (or REST-deploy it) → verify BOTH domains serve the new build.
- The cookie banner (`CookieConsent`) is position-fixed; `ConsentBottomSpacer` (same file, mounted in app-shell before `<Footer />`) reserves its measured height in the page flow while consent is undecided so fixed-banner overlays can never make bottom CTAs unreachable (this bug silently blocked checkout Place-order taps). Keep the spacer if the banner stays fixed.
- Store logo/banner uploads are normalized through sharp (≤1280px long edge, JPEG q85) before storage — the public sellers directory must never ship multi-MB base64 rows.
- `worklog.md` and `.env` are git-ignored; never commit tokens.
- Check `dev.log` (tail) for runtime errors after changes; lint + `tsc --noEmit` on BOTH apps before any deploy.

## E2E testing patterns that work here

- NextAuth credentials flow with cookie jars: GET `/api/auth/csrf` → POST `/api/auth/callback/credentials` (form-urlencoded). See `scripts/e2e-seller-flow.mjs` for the working harness (jars, multipart, the full seller questionnaire field list).
- GGPay sandbox test card: `4242424242424242`, any future `MM/YY`, any 3-digit CVV. Declines: tail `0002` (bank decline), `9995` (insufficient funds), `0069` (fraud flag).
- Store applications start `pending` — products require an `active` store (admin approves, or activate directly in the local DB for tests).
- Registering accounts is rate-limited (5/h/IP) — reuse fixed identities for re-runs.
- The admin console's own login route is rate-limited separately (10/5min).
