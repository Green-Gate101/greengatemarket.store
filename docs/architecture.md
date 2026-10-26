# Architecture

## Two apps

| App | Code | Domain | Hosting |
|---|---|---|---|
| Storefront + API | repository root (`src/`) | greengatemarket.store | Vercel project `greengate`, deploys from GitHub `Green-Gate101/greengatemarket.store` (`main`) |
| Admin console | `admin-console/` (also its own repo `Green-Gate101/greengate-admin-console`) | admin.greengatemarket.store | Vercel project `greengate-admin-console` |

The admin console never touches the database. It is a small server-side proxy: an
administrator signs in to it, it keeps a marketplace session cookie on the server, and it
calls the storefront's admin API (`/api/admin`, `/api/monitor`, `/api/payouts`, …) on
the administrator's behalf. Keep `admin-console/` and the admin repository identical.

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind 4 + shadcn/ui ·
Prisma 6 · NextAuth v4 (email + password, Google) · sharp for images · zod.

**Database.** Production runs on hosted **Postgres** (Vercel Postgres / Neon). The build
script `scripts/prepare-db.sh` picks the database: with `POSTGRES_*` integration variables
it pushes `prisma/schema.postgres.prisma` (additive changes only — it refuses changes that
would drop data) and generates the Postgres client. Local development and the test store
use SQLite (`prisma/schema.prisma`). **A production build without a working hosted
database fails on purpose** — the previous deployment stays live — because a production
site on a throwaway SQLite file would lose every order on the next cold start.
Keep both schema files in step (same models, same indexes).

## The storefront is one page

Every buyer and seller screen lives on `/` and is chosen by the address hash
(`#/product/<slug>`, `#/account`, `#/dashboard`, …), parsed in
`src/components/greengate/app-shell.tsx`. Add screens to `parseHash` and the view map — not
as new Next.js routes. The exceptions are the crawlable landing pages
`/product/<slug>` and `/store/<slug>` (link previews and search engines), which render
metadata on the server and then hand over to the single-page app.

`#/account` is the checkout (cart + delivery + place order). `#/checkout` is not a route.

## Rules that keep it safe

- **Never trust the browser.** Prices, delivery, stock and totals are recomputed on the
  server at checkout. Roles are re-read from the database on every privileged call
  (`requireUser`, `requireRole`, `requireStoreSeller` in `src/lib/auth.ts`).
- **Money is whole cents** everywhere (`priceCents`, `totalCents = subtotalCents + shippingCents`).
- **One order per store.** A cart with items from two sellers becomes two orders, each with its
  own delivery charge and its own payment to that seller.
- **Every outbound call has a timeout** (Courier Guy 6.5 s, Resend 12 s, Yoco 12 s, Algolia 4 s,
  geocoders 5–6 s, remove.bg 25 s). Nothing external may hang a request.
- **Secrets** (seller processor keys) are encrypted with AES-256-GCM (`src/lib/secret-box.ts`)
  using a key derived from `NEXTAUTH_SECRET`, and are write-only through the API.
- **Only active stores sell.** Catalogue, product pages, recommendations, cart and checkout all
  require `store.status === 'active'`.
- **A failed load never looks like "empty".** Screens show "We could not load … — Try again".
- **Read API answers safely** with `readJson(res)` or `res.json().catch(() => ({}))`.

## Where things live

| Area | Files |
|---|---|
| Screens | `src/components/greengate/*.tsx` |
| API | `src/app/api/**/route.ts` |
| Payments | `src/lib/ggpay.ts` (`settleOrderPayment`), `src/lib/seller-payments.ts`, `src/lib/yoco.ts`, `src/lib/order-payment-options.ts` |
| Delivery quotes | `src/lib/shipping.ts`, `src/app/api/shipping/route.ts`, checkout in `src/app/api/checkout/route.ts` |
| Images | `src/lib/image-processing.ts` (product photos), `src/lib/store-images.ts` (logos, banners), `src/lib/ai-image-guard.ts`, `src/app/api/images/*` |
| Sign-in | `src/lib/auth.ts`, `src/components/greengate/return-route.ts`, `session-guard.ts` |
| Monitoring | `src/app/api/monitor`, `src/app/api/cron/system-watch`, `src/app/api/health` |
| Analytics | seller: `src/app/api/seller/analytics`; admin: `src/app/api/admin` (insights) |
