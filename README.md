# GREEN GATE

A production-grade **multi-vendor fashion & lifestyle marketplace**. White-and-green
identity, formal rectangular UI (no pill buttons), full light/dark theming, and a
strict **no-AI-imagery policy enforced in code**.

## What is real here

| Area | Implementation |
| --- | --- |
| **Accounts** | NextAuth v4 — email + password (scrypt hashing, never plaintext), signed httpOnly JWT session cookies, email verification & password reset via Resend, Google OAuth ready (activates when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set) |
| **Roles** | BUYER / SELLER / ADMIN enforced server-side on every privileged route (the token is never trusted; roles are re-read from the database) |
| **No AI images** | Every upload passes a two-layer guard: deterministic metadata forensics (C2PA manifests, generator signatures, diffusion prompt chunks) + vision-model visual inspection. Synthetic images are rejected with an explanation; genuine photos pass |
| **White background** | Product photos are automatically placed on a clean studio-white background (sharp pipeline: flood fill, shadow absorption, gradient handling, alpha matting) |
| **Listings** | Database-driven category taxonomy (admin-extensible), products with variants (SKU, per-variant stock & price), moderation states, soft deletion |
| **Search** | Algolia with automatic fallback to database search; filters (category, price, brand, availability), sorting, pagination |
| **Cart & checkout** | Server-side cart, guest cart merge on sign-in, checkout recomputes **all** totals server-side, concurrency-safe stock decrement, idempotency keys, multi-seller order splitting |
| **Payments** | Bank transfer (EFT) with order-number reference; an order only becomes a confirmed sale after the seller/admin confirms receipt. `PaymentProvider` abstraction is ready for PayFast/Stripe/Yoco when merchant credentials exist — payment success is never declared by the browser |
| **Orders** | Full lifecycle (`pending_payment → confirmed → processing → packed → shipped → in_transit → out_for_delivery → delivered`, plus cancelled/returned/refunded) with a validated state machine, event timeline and buyer email notifications |
| **Analytics** | Seller dashboard reads real orders and real product events (views, cart adds, wishlist adds) with date-range filters (Today/7/30/90/365) — no random numbers anywhere |
| **Recommendations (ML)** | A real learning recommender (`src/lib/recommender.ts`): implicit-feedback shopper profiles with 45-day recency decay, item-item co-preference (collaborative filtering), content affinity (category/brand/price band), a Bayesian popularity prior, and an ensemble whose blend weights **learn from recommendation click-through**. All state persists in the `RecommendationState` table, so the algorithm never forgets what it learned — and guest profiles merge into accounts on sign-in |
| **Seller application** | A 6-step questionnaire (~30 questions): store identity, business & tax details, collection address, banking/payout details, product sourcing & fulfilment SLAs, and signed declarations. Drafts are auto-saved locally so an application is never lost |
| **Buyer onboarding** | Deliberately friction-free: name + email + password and the account is **signed in immediately** (verification email is still sent, but nothing blocks shopping) |
| **Skeleton loading** | Every data-driven view (storefront, recommendations, product, seller lists, dashboard, admin, store pages, wishlist, order timeline) renders proper skeletons while loading |
| **Reviews** | 1–5 ratings; the server decides `verified` from actual paid orders |
| **Admin** | Console for users, stores (suspend/reactivate), product moderation, orders, category management, audit log and integration health |
| **Security** | Rate limiting (auth, checkout, uploads, reviews), audit logging of sensitive actions, input validation everywhere, magic-byte file-type checks, secrets only in env vars, no stack traces to clients |
| **Legal** | Terms of Service and Privacy Policy pages, linked from the footer |

## Local development

```bash
bun install
cp .env.example .env          # fill in the values you own
bun run db:push               # create the SQLite schema
bun run dev                   # http://localhost:3000
bun run lint                  # ESLint (must be clean)
```

The database file lives in `db/`. Categories and the administrator account
(`ADMIN_EMAIL` / `ADMIN_PASSWORD`) are provisioned automatically on first request.

## Deployment (Vercel)

```bash
vercel link                   # once, to your project
vercel env add DATABASE_URL   # e.g. file:/tmp/greengate.db
vercel env add NEXTAUTH_SECRET
vercel env add ADMIN_EMAIL ADMIN_PASSWORD
# ...plus ALGOLIA_*, RESEND_API_KEY, COURIER_GUY_API_KEY, GOOGLE_CLIENT_ID/SECRET
vercel deploy --prod
```

`NEXTAUTH_URL` is intentionally not required: the app sets `AUTH_TRUST_HOST=true`,
so NextAuth derives the origin from proxy headers. Sign-in works on any domain
(localhost, preview URLs, production) without per-environment reconfiguration.

> **Production database note:** SQLite on Vercel is ephemeral per instance
> (`/tmp`). The app creates its schema at runtime so it always boots, but for
> durable multi-user commerce point `DATABASE_URL` at a hosted database and
> switch the Prisma datasource provider accordingly.

## Scaling to millions of users

The application layer is stateless and CDN-backed by design; the database is the
single point that must move from SQLite to a hosted engine for very large scale.

- **CDN**: static assets are content-hashed and immutable — served from Vercel's
  Edge Network worldwide. Public catalogue responses (`/api/products`,
  `/api/categories`) send `s-maxage` + `stale-while-revalidate` headers, so hot
  search and category pages are served from the edge without touching the
  database. Per-user endpoints (cart, orders, notifications) are never cached.
- **Stateless API**: no in-process session or cart state — every instance can
  serve any request, so Vercel scales instances horizontally without affinity.
- **Database readiness**: hot queries are covered by explicit indexes
  (product status/price/created/store/category, order status/store/buyer,
  events by product+type+date, notifications by user+read state), all list
  endpoints paginate (max 48/page), and stock mutation uses guarded atomic
  decrements — safe under concurrency. To go beyond a single SQLite file, point
  `DATABASE_URL` at hosted Postgres (Supabase/Neon/RDS) and switch the Prisma
  provider; the schema carries over with the same table/column names.
- **Search at scale**: Algolia handles typo-tolerant search off the primary
  database; `scripts/reindex-algolia.mjs` re-syncs the index any time (stale
  objects removed, live products upserted).
- **Abuse protection**: per-IP and per-user rate limits on auth, checkout and
  uploads; enumeration-safe auth errors; guarded writes and idempotent checkout.
- **Images**: stored as processed data URLs today. At large scale, stream them
  from object storage behind a CDN (Cloudflare R2 or Cloudinary credentials are
  available) to keep database payloads small.

## Enabling Google sign-in

1. Google Cloud Console → APIs & Services → Credentials → *Create OAuth client ID* (Web).
2. Authorised redirect URI: `https://YOUR-DOMAIN/api/auth/callback/google`.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the environment and redeploy.
   The "Continue with Google" button is already wired; until then it explains
   exactly what is missing (no fake success).

## Repository

```bash
git remote add origin git@github.com:Green-Gate101/green-gate.git
git push -u origin main
```

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · shadcn/ui · Prisma (SQLite;
swap to Postgres for scale) · NextAuth v4 · TanStack Query · Zustand · Recharts ·
sharp · Algolia · Resend · The Courier Guy · z-ai vision (AI-image detection)

## Known limits (honest list)

- SQLite on serverless is per-instance ephemeral — use a hosted DB for real scale.
- Resend's sandbox sender can only deliver to your own address until a domain is
  verified at resend.com/domains.
- The Courier Guy endpoint is unreachable from some networks; a transparent
  flat-rate table keeps checkout working either way.
- Bank-transfer payments reconcile manually by design until a payment gateway is
  connected.

## Production status (deployed)

- Live URL: https://green-gate-mauve.vercel.app (Vercel project `green-gate`,
  account `greengateindustriescom-6040`). Deployment protection is disabled —
  the site is public.
- Verified live: health/database, register + sign-in (buyer and admin), cookie
  consent, notifications, recommendations, catalogue CDN caching
  (`x-vercel-cache` HITs), theme and mobile layouts.
- The production database is the ephemeral per-instance SQLite (`/tmp`). All
  single-request flows work; durable cross-request storage for real multi-user
  traffic needs a hosted database. To switch: create a Postgres (Neon/Supabase)
  database, set `provider = "postgresql"` in `prisma/schema.prisma`, run
  `prisma db push` against it, set its `DATABASE_URL` on Vercel (production),
  and redeploy — the schema bootstraps itself on first boot.
- GitHub: pushing requires a token with repository access. The current fine
  -grained PAT authenticates as `Green-Gate101` but cannot create or access
  repositories. Create a classic PAT with `repo` scope (or a fine-grained PAT
  with Administration + Contents read/write on all repositories), then:
  `git push -u origin main`.
