#!/usr/bin/env bash
#
# Green Gate — one-command production deployment to Vercel.
#
# Usage:
#   VERCEL_TOKEN=vf2... ./scripts/deploy.sh
#
# Options (environment variables):
#   VERCEL_TOKEN    (required) Personal token from https://vercel.com/account/tokens
#   GITHUB_TOKEN    (optional) If set, the code is also pushed to the GitHub remote.
#   VERCEL_PROJECT  (optional) Existing project name on Vercel. Default: soko-market
#   VERCEL_SCOPE    (optional) Team/user scope if the token belongs to a team.
#   ADMIN_EMAIL     (optional) Admin account; generated if missing.
#   ADMIN_PASSWORD  (optional) Admin password; generated if missing.
#   DEPLOY_ENV_FILE (optional) File with additional values to sync as Vercel env
#                               vars, e.g. .env.deploy.local (never committed).
#
# The script is idempotent: it only adds Vercel environment variables that are
# missing for production, then deploys. Nothing in the repo is changed.

set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${VERCEL_PROJECT:-soko-market}"
SCOPE_ARGS=()
if [[ -n "${VERCEL_SCOPE:-}" ]]; then SCOPE_ARGS+=(--scope "$VERCEL_SCOPE"); fi
if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  echo "✗ VERCEL_TOKEN is required (https://vercel.com/account/tokens)" >&2
  exit 1
fi
V=(npx -y vercel --token "$VERCEL_TOKEN" "${SCOPE_ARGS[@]}")

echo "▶ Linking project '$PROJECT'…"
"${V[@]}" link --yes --project "$PROJECT" >/dev/null 2>&1 || "${V[@]}" link --yes --project "$PROJECT"

echo "▶ Syncing production environment variables (only missing ones are added)…"
existing="$("${V[@]}" env ls production 2>/dev/null | awk '{print $1}' | sort -u || true)"
add_env() { # name value
  local name="$1" value="$2"
  if [[ -z "$value" ]]; then return 0; fi
  if grep -qx "$name" <<<"$existing"; then
    echo "  = $name already set"
  else
    # Trailing newline is required — without it the CLI can store an empty value.
    printf '%s\n' "$value" | "${V[@]}" env add "$name" production >/dev/null
    echo "  + $name added"
  fi
}

gen_secret() { openssl rand -base64 32 | tr -d '\n'; }

# Required for a working deployment — generated when absent.
add_env DATABASE_URL  "${DATABASE_URL:-file:/tmp/greengate.db}"
add_env NEXTAUTH_SECRET "${NEXTAUTH_SECRET:-$(gen_secret)}"
add_env ADMIN_EMAIL   "${ADMIN_EMAIL:-admin@greengate.co.za}"
add_env ADMIN_PASSWORD "${ADMIN_PASSWORD:-$(gen_secret)}"

# Service integrations — picked up from the local environment if exported.
add_env ALGOLIA_APP_ID       "${ALGOLIA_APP_ID:-}"
add_env ALGOLIA_ADMIN_KEY    "${ALGOLIA_ADMIN_KEY:-}"
add_env ALGOLIA_INDEX_NAME   "${ALGOLIA_INDEX_NAME:-}"
add_env RESEND_API_KEY       "${RESEND_API_KEY:-}"
add_env RESEND_FROM          "${RESEND_FROM:-}"
add_env COURIER_GUY_API_KEY  "${COURIER_GUY_API_KEY:-}"
add_env GOOGLE_CLIENT_ID     "${GOOGLE_CLIENT_ID:-}"
add_env GOOGLE_CLIENT_SECRET "${GOOGLE_CLIENT_SECRET:-}"
# PayFast card payments — active the moment the merchant id + key are present.
add_env PAYFAST_MERCHANT_ID  "${PAYFAST_MERCHANT_ID:-}"
add_env PAYFAST_MERCHANT_KEY "${PAYFAST_MERCHANT_KEY:-}"
add_env PAYFAST_PASSPHRASE   "${PAYFAST_PASSPHRASE:-}"
add_env PAYFAST_SANDBOX      "${PAYFAST_SANDBOX:-}"

# Optional extras from a local (git-ignored) file: KEY=VALUE lines.
if [[ -n "${DEPLOY_ENV_FILE:-}" && -f "$DEPLOY_ENV_FILE" ]]; then
  while IFS='=' read -r k v; do
    [[ -z "$k" || "$k" =~ ^# ]] && continue
    add_env "$k" "$v"
  done < <(sed 's/[[:space:]]*$//' "$DEPLOY_ENV_FILE")
fi

echo "▶ Deploying to production…"
URL="$("${V[@]}" deploy --prod --yes | tail -1)"
echo "✓ Deployed: $URL"

if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  echo "▶ Pushing to GitHub…"
  if ! git remote get-url origin >/dev/null 2>&1; then
    git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/Green-Gate101/soko-market.git"
  fi
  git push origin HEAD:main
  echo "✓ Pushed to GitHub (main)"
fi

echo "✓ Done. Production: https://${PROJECT}.vercel.app"
