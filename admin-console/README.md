# Green Gate — Admin Console

Standalone operator console for the Green Gate marketplace, deployed to
**https://admin.greengatemarket.store** (Vercel project `greengate-admin`).

## How it works

- This is a **separate, self-contained Next.js app** — it shares no code with
  the marketplace and the marketplace was **not modified** for it.
- Sign-in performs the marketplace's standard NextAuth credentials flow
  **server-to-server**. The marketplace session cookie is parked in an
  httpOnly cookie scoped to the console's own domain; browser JavaScript
  never sees it.
- Every dashboard figure comes from the marketplace's live database via
  `GET /api/admin` (proxied by `src/app/api/console/data`).
- Actions (approve stores, moderate products, ban/unban, confirm payments,
  deletes, categories) are forwarded to `POST /api/admin`, where the
  marketplace enforces role, rate limits and audit logging.

## Environment

| Variable        | Default                          | Purpose                          |
| --------------- | -------------------------------- | -------------------------------- |
| `MAIN_SITE_URL` | `https://www.greengatemarket.store` | Marketplace the console operates |

## Develop

```bash
cd admin-console
npm install          # or bun install
MAIN_SITE_URL=http://localhost:3000 npm run dev   # console on :3100, marketplace on :3000
```

## Deploy

```bash
VERCEL_TOKEN=... node scripts/deploy-admin-rest.mjs
```

The script uploads only tracked files under `admin-console/` (paths relative
to that root, so Vercel builds this app), ensures `MAIN_SITE_URL` is set on
the project, creates the production deployment and polls until READY.
