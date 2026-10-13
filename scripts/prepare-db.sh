#!/bin/bash
# Build-time database preparation — adapts the Prisma client (and, for hosted
# databases, the schema) to whatever DATABASE_URL points at.
#
# - postgres://… / postgresql://…  → generate the Postgres client and push the
#   schema to the hosted database (idempotent; data is preserved).
# - anything else (local/ephemeral SQLite) → generate the SQLite client; the
#   runtime bootstrap creates the schema.
#   NEW (fail-safe cutover): when the platform provides hosted Postgres
#   integration vars (Supabase/Neon: POSTGRES_URL_NON_POOLING /
#   POSTGRES_PRISMA_URL / POSTGRES_URL) while DATABASE_URL is still an
#   ephemeral file:, the hosted schema is pushed and the Postgres client
#   generated INSTEAD, and src/lib/db-mode.gen.ts is written with 'postgres'
#   so the runtime connects to the durable database. Any failure in that path
#   falls back to the SQLite client exactly as before — the build never breaks.
set -e

DB_MODE="sqlite"

case "${DATABASE_URL:-}" in
  postgres://*|postgresql://*)
    echo "[prepare-db] hosted Postgres detected — generating Postgres client"
    # Neon: migrations must run on the direct (unpooled) endpoint. DIRECT_URL is
    # set at cutover; fall back through UNPOOLED -> DATABASE_URL so any hosted
    # Postgres (Neon or not) keeps working even when DIRECT_URL is absent.
    export DIRECT_URL="${DIRECT_URL:-${DATABASE_URL_UNPOOLED:-$DATABASE_URL}}"
    npx prisma generate --schema prisma/schema.postgres.prisma
    echo "[prepare-db] pushing schema to hosted database (idempotent, data-preserving)"
    # NO --accept-data-loss: if a schema change would ever destroy data the
    # build FAILS LOUDLY instead of silently wiping customer data. Additive
    # changes (new tables/columns) push exactly as before.
    npx prisma db push --schema prisma/schema.postgres.prisma --skip-generate
    DB_MODE="postgres"
    ;;
  *)
    # Platform-provided hosted Postgres (integration vars) + ephemeral file:
    # DATABASE_URL → attempt the durable-database cutover at build time.
    PUSH_URL=""
    for cand in "${POSTGRES_URL_NON_POOLING:-}" "${DIRECT_URL:-}" "${POSTGRES_PRISMA_URL:-}" "${POSTGRES_URL:-}"; do
      case "$cand" in
        postgres://*|postgresql://*) PUSH_URL="$cand"; break ;;
      esac
    done
    if [ -n "$PUSH_URL" ]; then
      echo "[prepare-db] hosted Postgres integration vars detected — attempting durable-database cutover"
      # Schema push runs over the DIRECT (non-pooled) endpoint; the runtime
      # client prefers the pooled POSTGRES_PRISMA_URL for serverless traffic.
      # NO --accept-data-loss (see above) — customer data is never silently
      # destroyed during an update.
      if DATABASE_URL="$PUSH_URL" DIRECT_URL="$PUSH_URL" npx prisma db push --schema prisma/schema.postgres.prisma --skip-generate; then
        echo "[prepare-db] hosted schema pushed — generating Postgres client"
        npx prisma generate --schema prisma/schema.postgres.prisma
        DB_MODE="postgres"
      else
        echo "[prepare-db] hosted push failed — falling back to the SQLite client (build continues)"
      fi
    fi
    if [ "$DB_MODE" != "postgres" ]; then
      echo "[prepare-db] SQLite detected — generating SQLite client"
      npx prisma generate
    fi
    ;;
esac

# Build-mode marker consumed by src/lib/db.ts — the runtime connection always
# follows the actual build outcome (never points at an unverified database).
cat > src/lib/db-mode.gen.ts <<EOF
// AUTO-GENERATED at build time by scripts/prepare-db.sh — do not edit by hand.
// Generated mode: $DB_MODE (postgres = hosted schema pushed; sqlite = fallback).
export const BUILD_DB_MODE: 'sqlite' | 'postgres' = '$DB_MODE';
EOF
echo "[prepare-db] db mode: $DB_MODE"

echo "[prepare-db] next build"
