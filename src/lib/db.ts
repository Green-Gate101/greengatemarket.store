import { PrismaClient } from '@prisma/client'
import { BUILD_DB_MODE } from './db-mode.gen';

/**
 * Runtime database URL.
 *
 * When the build pushed the schema to a hosted Postgres (Supabase/Neon
 * integration vars; scripts/prepare-db.sh decides and writes db-mode.gen.ts),
 * the durable hosted URL wins over an ephemeral file: DATABASE_URL — this is
 * what ends per-instance data loss on serverless hosts. In every other case
 * the classic DATABASE_URL is used unchanged (local SQLite development).
 */
const hostedPostgresUrl = [process.env.POSTGRES_PRISMA_URL, process.env.POSTGRES_URL]
  .find((u): u is string => !!u && u.startsWith('postgres'));
const databaseUrl =
  BUILD_DB_MODE === 'postgres' && hostedPostgresUrl
    ? hostedPostgresUrl
    : process.env.DATABASE_URL;

/** True when the app is connected to a hosted Postgres (schema comes from the
 *  build-time `prisma db push`, not the SQLite runtime DDL in bootstrap.ts). */
export const IS_POSTGRES = !!databaseUrl && databaseUrl.startsWith('postgres');

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient(databaseUrl ? { datasourceUrl: databaseUrl } : undefined)

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
