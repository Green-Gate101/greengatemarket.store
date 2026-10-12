// Neon infrastructure-as-code for Green Gate (greengatemarket.store).
//
// Declares every Neon service this app uses on the linked branch:
//   - Lakebase Postgres: always present (the app's persistent DATABASE_URL —
//     the fix that makes user data survive forever instead of living in
//     per-instance /tmp SQLite).
//   - auth: Neon Auth (Managed Better Auth) — provisioned as requested. The
//     marketplace's own NextAuth keeps running as-is; this only creates the
//     neon_auth schema so the service is ready if identity ever consolidates.
//   - functions: reserved slot for Neon Functions (no function source yet).
//   - buckets: public-read media bucket, ready for product/store imagery.
//
// Apply with:  neon deploy   (after `neon link` + `neon auth`, see
// scripts/switch-neon.sh which drives the whole cutover).
import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  auth: true,
  functions: {},
  buckets: {
    "gg-media": { access: "public_read" },
  },
});
