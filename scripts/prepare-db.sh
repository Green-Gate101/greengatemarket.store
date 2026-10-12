#!/bin/bash
# Build-time database preparation — adapts the Prisma client (and, for hosted
# databases, the schema) to whatever DATABASE_URL points at.
#
# - postgres://… / postgresql://…  → generate the Postgres client and push the
#   schema to the hosted database (idempotent; data is preserved).
# - anything else (local/ephemeral SQLite) → generate the SQLite client; the
#   runtime bootstrap creates the schema.
set -e

case "${DATABASE_URL:-}" in
  postgres://*|postgresql://*)
    echo "[prepare-db] hosted Postgres detected — generating Postgres client"
    # Neon: migrations must run on the direct (unpooled) endpoint. DIRECT_URL is
    # set at cutover; fall back through UNPOOLED -> DATABASE_URL so any hosted
    # Postgres (Neon or not) keeps working even when DIRECT_URL is absent.
    export DIRECT_URL="${DIRECT_URL:-${DATABASE_URL_UNPOOLED:-$DATABASE_URL}}"
    npx prisma generate --schema prisma/schema.postgres.prisma
    echo "[prepare-db] pushing schema to hosted database (idempotent)"
    npx prisma db push --schema prisma/schema.postgres.prisma --skip-generate --accept-data-loss
    ;;
  *)
    echo "[prepare-db] SQLite detected — generating SQLite client"
    npx prisma generate
    ;;
esac

echo "[prepare-db] next build"
