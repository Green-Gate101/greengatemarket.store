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
