# Operations

## Deploying (both apps, every time)

1. `bunx tsc --noEmit` and `bun run lint` in the storefront; `bunx tsc --noEmit` in the admin console.
2. Run the local suites (see [testing.md](testing.md)).
3. Commit and push the storefront to `Green-Gate101/greengatemarket.store` `main`. Vercel builds
   production automatically, and the **device lab** GitHub Action runs on the same push.
4. Copy `admin-console/` to the admin repository and push it to `Green-Gate101/greengate-admin-console`
   `main`. If its GitHub webhook misses, start the build with the Vercel API
   (`POST /v13/deployments` with `gitSource`) or `scripts/deploy-admin-rest.mjs`.
5. Wait until both deployments are **READY** for the pushed commit, then verify live:
   - `/api/health` answers `ok`;
   - pages load on phone and desktop browsers;
   - the admin console signs in;
   - the device lab is green.

A production build **fails on purpose** when the hosted Postgres database is missing or its
schema push fails (`scripts/prepare-db.sh`). The previous deployment keeps serving. Fix the
database variables or re-run; never "fix" it by allowing SQLite in production.

## Environment variables (Vercel, storefront)

| Variable | Needed for |
|---|---|
| `POSTGRES_PRISMA_URL`, `POSTGRES_URL_NON_POOLING`, … | the production database (Vercel Postgres / Neon integration) |
| `NEXTAUTH_SECRET`, `NEXTAUTH_URL` | sessions and encryption of seller secrets — never change the secret casually: saved processor keys become unreadable |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first administrator only (never re-applied) |
| `CRON_SECRET` | authenticates the cron routes |
| `RESEND_API_KEY`, `RESEND_FROM` | email |
| `COURIER_GUY_API_KEY`, `COURIER_GUY_ACCOUNT_ID` | Courier Guy merchant rates |
| `ALGOLIA_*` | search (database search is the fallback) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | shared rate limiting across instances (Upstash Redis) |
| `PAYFAST_MERCHANT_ID/KEY/PASSPHRASE` | optional marketplace PayFast account |
| `REMOVE_BG_API_KEY` | optional: white backgrounds for busy product photos (see [images.md](images.md)) |
| `YOCO_PLATFORM_SECRET_KEY` | Green Gate's own Yoco account — seller subscription payments (see [subscriptions.md](subscriptions.md)). Live key only; never a seller's key |
| `SELLER_PLAN_MONTHLY_CENTS`, `SELLER_PLAN_YEARLY_CENTS` | optional: subscription prices in cents (default 49900 / 699900) |
| `ADMIN_CONSOLE_URL` | optional: where "Message from <store>" notifications send admins (default `https://admin.greengatemarket.store`) |
| `GG_PLATFORM_FEE_PERCENT` | platform fee on marketplace-rail payouts (default 5) |

Preview deployments do not get production secrets or the database. Keep it that way.

## Monitoring

- `/api/health` (public): database, search, email, delivery, payments posture, Google sign-in.
- Admin console → **System monitor** polls `/api/monitor` every second: deep checks and incidents.
- `/api/cron/system-watch` runs daily on the Hobby plan. For round-the-clock alerts, point an
  external pinger (UptimeRobot, cron-job.org) at it every minute with
  `Authorization: Bearer <CRON_SECRET>`. It emails `ADMIN_EMAIL` once per incident and once on recovery.
- `/api/cron/abandoned-checkouts` (daily): reminds about unpaid orders, then cancels and
  restocks after `UNPAID_ORDER_CANCEL_DAYS` (default 7).
- Admin console → **API & billing**: real outbound call counts per service.

## Runbooks

**"Buyers say they can't pay a seller."** Open the store in the admin console. Check that the
seller's processor is connected and "ready" (dashboard → Payment details shows the same).
Common causes: missing PayFast passphrase, missing Ozow API key, Yoco test key.

**"Delivery prices look like R45 / R75 / R130."** Those are the fallback table. The Courier
Guy gateway was unreachable or the address couldn't be mapped. Check `/api/health` and the
seller's store location (it must name a South African town or city).

**"A seller's new logo doesn't show."** The address carries a version, so a fresh page load
shows it at once. If not, check the audit log for `store_branding_updated`, and that the seller
saved without an error message.

**"The site is down."** Check `/api/health` and the System monitor. If the database is
unreachable, the monitor answers 503 "Database unreachable". Check the Postgres provider's
status page. A failed deploy never replaces a working one, so roll back in Vercel if a new
deployment misbehaves (Deployments → previous → Promote).

**"Too many requests" for many users at once.** The per-IP limits are generous because of
carrier NAT. If a limit is hit by real traffic, raise it in the route rather than removing it.

## Security hygiene

- Rotate the GitHub and Vercel tokens that were shared for maintenance, and change the admin
  password after any hand-over.
- Never commit `.env` or tokens. Seller secrets are write-only through the API.
