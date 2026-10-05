# Soko Market

A multi-vendor marketplace connecting South African sellers with buyers nationwide.
Live at **https://soko-market.vercel.app**

## Features

**Marketplace (buyers)**
- Product catalogue with category filtering and instant search (Algolia, with an
  automatic database fallback)
- Multi-seller cart: items are grouped per store and charged shipping per store,
  exactly like a real multi-vendor marketplace
- Courier rates at checkout (The Courier Guy live API with a transparent
  flat-rate fallback), email receipts via Resend
- Stock control: quantities validated across the cart, stock decremented on
  purchase, sold-out states across the UI

**Sellers**
- Two-minute onboarding — stores appear on the marketplace immediately
- Product uploads with **automatic white-background processing**: every photo
  passes through a sharp-based studio pipeline (border flood-fill, contact-shadow
  absorption, gradient fill, enclosed-region cleanup, median alpha matting) and
  ships as a clean product shot on white — see the before/after preview in the
  product manager
- Seller dashboard: 14-day revenue, orders and units-sold charts (Recharts),
  average order value, best sellers, revenue by category, low-stock alerts and a
  recent-orders table

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · shadcn/ui ·
Prisma + SQLite · TanStack Query · Zustand · Recharts · sharp

## Integrations

| Service | Purpose | Status |
|---|---|---|
| Algolia | product search indexing + queries | verified live |
| Resend | order receipts + seller welcome email | verified live |
| Vercel | hosting + serverless functions | verified live |
| The Courier Guy | live courier rates | key stored; endpoint unreachable from the build sandbox, flat-rate fallback active |

## Local development

```bash
bun install
cp .env.example .env          # fill in values
bun run db:push               # create tables
bun run dev                   # http://localhost:3000
```

The database seeds itself with a two-week demo dataset on first request
(`src/lib/seed.ts`), including product photos already processed through the
white-background pipeline (`src/lib/seed-products.ts`, regenerated from
`seed-images/` with `bun run scripts/generate-seed-assets.ts`).

## Deployment notes

- `vercel.json` sets the build command (`prisma generate && next build`).
- On serverless hosts the SQLite file lives in `/tmp` and starts empty; the
  schema is created at runtime (`src/lib/schema.ts`) and the demo dataset is
  reseeded automatically on cold start.
- **For production persistence**, point `DATABASE_URL` at a hosted Postgres
  (Supabase / Neon / RDS) — the Prisma schema is portable; SQLite is used only
  for the zero-config demo. Seller identity in the UI is keyed on the store
  email, so the demo stays consistent across reseeds.
