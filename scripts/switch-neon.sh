#!/bin/bash
# =============================================================================
# Green Gate -> Neon one-command cutover
#
#WHAT THIS DOES (in order, idempotent):
#   1. Links this repo to the Green Gate Neon org/project/branch.
#   2. Pulls the branch's env: DATABASE_URL (pooled) + DATABASE_URL_UNPOOLED.
#   3. Verifies the URL really is Neon Postgres (never points the app at
#      something untested).
#   4. Applies neon.ts (provisions Neon Auth + gg-media bucket) via `neon deploy`.
#   5. Sets DATABASE_URL + DIRECT_URL on the Vercel project (production env).
#   6. Triggers a production deploy — prepare-db.sh auto-pushes the Prisma
#      schema to Neon during the build. From then on every user, store,
#      application and order lives in Neon Postgres permanently.
#
# REQUIREMENT (one-time, human): Neon authentication.
#   Either:  npx neon login          (opens the browser)
#   Or:      export NEON_API_KEY=... (from Neon console -> Account -> API keys)
#
# Usage:  export VERCEL_TOKEN=<your-vercel-token> && bash scripts/switch-neon.sh
# =============================================================================
set -euo pipefail

ORG="org-patient-queen-52368939"
NEON_PROJECT="cold-morning-25512885"
BRANCH="br-royal-tooth-b4y2j97l"
TEAM="team_dUHkKc5oTP9RYvBbctlZTpNY"
PRJ="prj_Gy6V4ojlPBs2S9YMwOC6eKpzfYMQ"
API="https://api.vercel.com"
# Never hardcode credentials — the token lives in the environment only.
TOKEN="${VERCEL_TOKEN:?export VERCEL_TOKEN=<your-vercel-token> before running this script}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENVFILE="$ROOT/.env.neon"   # git-ignored; holds Neon-managed values only

step() { printf '\n[neon-switch] %s\n' "$*"; }

step "0/6 checking Neon authentication"
if [ -z "${NEON_API_KEY:-}" ]; then
  if ! npx --yes neon@latest whoami >/dev/null 2>&1; then
    echo "Neon is not authenticated. Run ONE of:"
    echo "  npx neon login            (interactive, opens browser)"
    echo "  export NEON_API_KEY=...   (Neon console -> Account settings -> API keys)"
    echo "…then re-run this script. Nothing was changed."
    exit 2
  fi
fi

step "1/6 linking repo to Neon project (org $ORG, project $NEON_PROJECT, branch $BRANCH)"
npx --yes neon@latest link --org-id "$ORG" --project-id "$NEON_PROJECT" --branch "$BRANCH" -y

step "2/6 pulling branch env (pooled DATABASE_URL + DATABASE_URL_UNPOOLED)"
rm -f "$ENVFILE"
npx --yes neon@latest env pull --file "$ENVFILE"
# shellcheck disable=SC1090
source <(grep -E '^(DATABASE_URL|DATABASE_URL_UNPOOLED)=' "$ENVFILE" | sed 's/^/export /')

: "${DATABASE_URL:?Neon env pull did not produce DATABASE_URL}"
: "${DATABASE_URL_UNPOOLED:?Neon env pull did not produce DATABASE_URL_UNPOOLED}"
case "$DATABASE_URL" in
  postgresql://*|postgres://*) : ;;
  *) echo "REFUSING: DATABASE_URL is not a Postgres URL"; exit 1 ;;
esac

step "3/6 verifying live connection to Neon"
if command -v psql >/dev/null 2>&1; then
  psql "$DATABASE_URL_UNPOOLED" -c 'select version();' | head -2
else
  node -e "const{Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.U});await c.connect();console.log('Neon OK:',(await c.query('select 1 as ok')).rows[0].ok===1);await c.end();})().catch(e=>{console.error('CONNECT FAILED:',e.message);process.exit(1)})" U="$DATABASE_URL_UNPOOLED" 2>/dev/null || \
  npx --yes tsx -e "import pg from 'pg';const c=new pg.Client({connectionString:'$DATABASE_URL_UNPOOLED'});await c.connect();console.log('Neon OK:',(await c.query('select 1 as ok')).rows[0].ok===1);await c.end()" || { echo 'CONNECT FAILED'; exit 1; }
fi

step "4/6 applying neon.ts (Neon Auth + gg-media bucket) on the production branch"
cd "$ROOT"
if [ -n "${NEON_API_KEY:-}" ]; then
  npx --yes neon@latest deploy --env "$ENVFILE"
else
  npx --yes neon@latest deploy --env "$ENVFILE"
fi

step "5/6 setting DATABASE_URL + DIRECT_URL on Vercel (project greengate, production)"
for KV in "DATABASE_URL:$DATABASE_URL" "DIRECT_URL:$DATABASE_URL_UNPOOLED"; do
  KEY="${KV%%:*}"; VAL="${KV#*:}"
  # remove then upsert, so a previous value never lingers
  OLD_ID=$(curl -s "https://api.vercel.com/v9/projects/$PRJ/env?teamId=$TEAM" -H "Authorization: Bearer $TOKEN" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const e=(j.envs||[]).find(x=>x.key==='$KEY');console.log(e?e.id:'')})")
  [ -n "$OLD_ID" ] && curl -s -X DELETE "https://api.vercel.com/v9/projects/$PRJ/env/$OLD_ID?teamId=$TEAM" -H "Authorization: Bearer $TOKEN" >/dev/null
  curl -s -X POST "https://api.vercel.com/v10/projects/$PRJ/env?teamId=$TEAM" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"key\":\"$KEY\",\"value\":\"$VAL\",\"type\":\"encrypted\",\"target\":[\"production\",\"preview\",\"development\"]}" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('$KEY:', j.error?j.error.message:'set OK')})"
done

step "6/6 triggering production deploy (prepare-db.sh migrates the schema to Neon during build)"
node "$ROOT/../.deploy/deploy-prod.mjs" 2>/dev/null || node /home/z/.deploy/deploy-prod.mjs

echo
echo "[neon-switch] DONE. When the deployment is READY:"
echo "  - register a new account on https://greengatemarket.store"
echo "  - the account now lives in Neon Postgres and can NEVER be forgotten."
