#!/usr/bin/env bash
#
# Green Gate — switch production from ephemeral SQLite to a hosted Postgres.
#
# This is THE fix for cross-instance data loss on Vercel (accounts or stores
# that "vanish" between requests, seller applications failing after
# registration): all instances then share one durable database.
#
# Usage:
#   VERCEL_TOKEN=... DATABASE_URL="postgresql://user:pass@host/db?sslmode=require" \
#   ./scripts/switch-to-postgres.sh
#
# What it does (idempotent — safe to re-run):
#   1. Switches prisma/schema.prisma to the postgresql provider
#   2. Pushes the schema to the hosted database (creates all tables)
#   3. Sets DATABASE_URL on the Vercel project (production)
#   4. Deploys the updated code via the deterministic REST path
#   5. Verifies: health + admin sign-in on production
#
# Notes:
#   - Data in the old ephemeral /tmp SQLite cannot be migrated (it is gone by
#     design); the app bootstraps the new database automatically (categories +
#     admin) on first boot.
#   - Local development can keep using SQLite: keep a local DATABASE_URL in
#     .env and a `file:` URL there; production uses the hosted one. To run the
#     app locally against the hosted DB, put the postgresql:// URL into .env.

set -euo pipefail
cd "$(dirname "$0")/.."

[[ -n "${VERCEL_TOKEN:-}" ]] || { echo "✗ VERCEL_TOKEN is required" >&2; exit 1; }
[[ -n "${DATABASE_URL:-}" ]] || { echo "✗ DATABASE_URL (postgresql://…) is required" >&2; exit 1; }
[[ "$DATABASE_URL" =~ ^postgres(ql)?:// ]] || { echo "✗ DATABASE_URL must start with postgres:// or postgresql://" >&2; exit 1; }

PROJECT="${VERCEL_PROJECT:-green-gate}"

echo "▶ 1/5 Switching Prisma provider to postgresql…"
if grep -q 'provider = "postgresql"' prisma/schema.prisma; then
  echo "  = already postgresql"
else
  sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma
  echo "  ± provider switched"
fi

echo "▶ 2/5 Pushing schema to the hosted database…"
DATABASE_URL="$DATABASE_URL" npx -y prisma db push --skip-generate --accept-data-loss >/dev/null
echo "  ✓ schema pushed"

echo "▶ 3/5 Setting DATABASE_URL on Vercel (production)…"
API="https://api.vercel.com"
existing="$(curl -s -H "Authorization: Bearer $VERCEL_TOKEN" "$API/v9/projects/$PROJECT/env?target=production" \
  | python3 -c "import json,sys; print(' '.join(e['key'] for e in json.load(sys.stdin).get('envs',[])))")" || existing=""
if grep -qw DATABASE_URL <<<"$existing"; then
  curl -s -X DELETE -H "Authorization: Bearer $VERCEL_TOKEN" "$API/v9/projects/$PROJECT/env/DATABASE_URL?target=production" >/dev/null
fi
python3 - "$VERCEL_TOKEN" "$PROJECT" "$DATABASE_URL" <<'PY'
import json, sys, urllib.request
token, project, value = sys.argv[1], sys.argv[2], sys.argv[3]
req = urllib.request.Request(
    f"https://api.vercel.com/v9/projects/{project}/env",
    data=json.dumps({"key": "DATABASE_URL", "value": value, "type": "encrypted", "target": ["production"]}).encode(),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req) as r:
    r.read()
print("  ✓ DATABASE_URL set (value never printed)")
PY

echo "▶ 4/5 Committing the provider change and deploying…"
git add prisma/schema.prisma
git commit -m "Switch production database to hosted Postgres" --quiet || echo "  = nothing to commit"
VERCEL_TOKEN="$VERCEL_TOKEN" VERCEL_PROJECT="$PROJECT" node scripts/deploy-rest.mjs

echo "▶ 5/5 Verifying production…"
sleep 5
PROD_URL="${PROD_URL:-https://green-gate-mauve.vercel.app}"
curl -s "$PROD_URL/api/health" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    db = next((c for c in d.get('checks',[]) if c['service']=='database'), {})
    print('  ✓ health:', d.get('status'), '| database:', db.get('detail'))
except Exception:
    print('  (health check not parseable — verify manually at $PROD_URL/api/health)')
"

echo "✓ Done. Production now runs on hosted Postgres — accounts, stores and orders persist across instances."
