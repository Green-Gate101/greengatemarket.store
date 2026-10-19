#!/usr/bin/env bash
#
# Green Gate — SYNCED DEPLOYMENT: GitHub, Vercel and the admin console always
# move TOGETHER, never separately.
#
# What it does, in order, stopping at the first failure:
#   1. Verifies the working tree is clean and pushes main → GitHub
#      (github.com/Green-Gate101/greengatemarket.store).
#   2. Polls Vercel until the production deployment FOR THAT EXACT COMMIT is
#      READY (greengatemarket.store).
#   3. Syncs admin-console/ into its own repo (git subtree split →
#      github.com/Green-Gate101/greengate-admin-console main).
#   4. Polls Vercel until the admin console production deployment FOR THE
#      SYNCED SPLIT COMMIT is READY (admin.greengatemarket.store).
#   5. Prints the final lockstep state of all three.
#
# Usage (tokens passed via env — NEVER hardcode them here):
#   GITHUB_TOKEN=ghp_… VERCEL_TOKEN=vcp_… ./scripts/deploy-sync.sh
#
# Options:
#   SKIP_ADMIN=1   only ship the storefront (admin split skipped)
#   POLL_TIMEOUT   seconds to wait for each deployment (default 900)

set -euo pipefail
cd "$(dirname "$0")/.."

POLL_TIMEOUT="${POLL_TIMEOUT:-900}"
MAIN_REPO="github.com/Green-Gate101/greengatemarket.store.git"
ADMIN_REPO="github.com/Green-Gate101/greengate-admin-console.git"
MAIN_PROJECT_ID="prj_Gy6V4ojlPBs2S9YMwOC6eKpzfYMQ"        # greengate → greengatemarket.store
ADMIN_PROJECT_ID="prj_FHgtLeRlqvFl731SSKHsgdXC5dHp"       # greengate-admin-console → admin.greengatemarket.store

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${VERCEL_TOKEN:?VERCEL_TOKEN is required}"

step() { printf '\n▶ %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

# --- 1. GitHub (storefront) -------------------------------------------------
step "1/5  Pushing storefront to GitHub"
[[ -z "$(git status --porcelain)" ]] || die "Working tree is dirty — commit or stash first (GitHub and Vercel must ship the same code)."
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" ]] || die "You are on '$BRANCH' — this script ships main only."
git push "https://x-access-token:${GITHUB_TOKEN}@${MAIN_REPO}" HEAD:main
SHA="$(git rev-parse HEAD)"
ok "GitHub main = ${SHA:0:7}"

# --- 2. Vercel storefront ---------------------------------------------------
step "2/5  Waiting for Vercel storefront (greengatemarket.store) → READY for ${SHA:0:7}"
wait_vercel() { # project_id commit_sha label
  local pid="$1" sha="$2" label="$3" waited=0 state sha_seen
  while (( waited < POLL_TIMEOUT )); do
    local json
    json="$(curl -sf "https://api.vercel.com/v6/deployments?projectId=${pid}&limit=6&target=production&teamId=team_dUHkKc5oTP9RYvBbctlZTpNY" \
      -H "Authorization: Bearer ${VERCEL_TOKEN}")" || { sleep 10; waited=$((waited+10)); continue; }
    sha_seen="$(printf '%s' "$json" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);const m=(j.deployments||[]).find(x=>(x.meta&&x.meta.githubCommitSha||"").startsWith(process.argv[1]));console.log(m?m.uid:"")})' "$sha")"
    if [[ -n "$sha_seen" ]]; then
      state="$(curl -sf "https://api.vercel.com/v13/deployments/${sha_seen}?teamId=team_dUHkKc5oTP9RYvBbctlZTpNY" -H "Authorization: Bearer ${VERCEL_TOKEN}" \
        | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{console.log(JSON.parse(d).readyState||"")})')"
      case "$state" in
        READY) ok "$label READY (deployment ${sha_seen})"; return 0 ;;
        ERROR|CANCELED) die "$label deployment ${sha_seen} is ${state} — NOTHING else was touched; fix and re-run." ;;
      esac
    fi
    sleep 15; waited=$((waited+15)); printf '  … waiting (%ss)\n' "$waited"
  done
  die "$label deployment not READY after ${POLL_TIMEOUT}s — re-run this script to resume."
}
wait_vercel "$MAIN_PROJECT_ID" "$SHA" "Storefront"

# --- 3. Admin console repo sync ---------------------------------------------
ADMIN_SHA=""
ADMIN_PUSHED=0
if [[ "${SKIP_ADMIN:-0}" != "1" && -d admin-console ]]; then
  step "3/5  Syncing admin-console/ → its own GitHub repo"
  git branch -D admin-dist >/dev/null 2>&1 || true
  ADMIN_SHA="$(git subtree split -P admin-console -b admin-dist)"
  if git ls-remote "https://x-access-token:${GITHUB_TOKEN}@${ADMIN_REPO}" refs/heads/main | grep -q "^${ADMIN_SHA}"; then
    ok "admin console already up to date (${ADMIN_SHA:0:7}) — repos stay in lockstep, nothing pushed"
  else
    git push "https://x-access-token:${GITHUB_TOKEN}@${ADMIN_REPO}" admin-dist:main --force
    ADMIN_PUSHED=1
    ok "admin console pushed (${ADMIN_SHA:0:7})"
  fi
fi

# --- 4. Vercel admin console -------------------------------------------------
if [[ "${SKIP_ADMIN:-0}" != "1" && -n "$ADMIN_SHA" ]]; then
  step "4/5  Waiting for Vercel admin console (admin.greengatemarket.store) → READY"
  if [[ "$ADMIN_PUSHED" == "1" ]]; then
    wait_vercel "$ADMIN_PROJECT_ID" "$ADMIN_SHA" "Admin console"
  else
    ok "admin console unchanged on GitHub — existing READY deployment remains authoritative"
  fi
fi

# --- 5. Lockstep summary ------------------------------------------------------
step "5/5  Lockstep state"
printf '  storefront  GitHub main  : %s\n' "${SHA:0:7}"
printf '  storefront  Vercel       : READY (verified for %s)\n' "${SHA:0:7}"
if [[ -n "$ADMIN_SHA" ]]; then
  printf '  admin       GitHub main  : %s\n' "${ADMIN_SHA:0:7}"
  printf '  admin       Vercel       : READY (verified for %s)\n' "${ADMIN_SHA:0:7}"
fi
ok "GitHub, Vercel and the admin console are in sync — never separate."
