/**
 * sharp, loaded on first use instead of at import time.
 *
 * sharp is a native module. Imported at the top of a file, a missing or
 * broken binary on some runtime fails the whole module graph — every route
 * that imports an image helper went down with it, the product catalogue
 * (GET /api/products) and the sellers API included. Loaded lazily, only the
 * image work itself fails, and each caller already has its own fallback or
 * honest error for that.
 */
type Sharp = Awaited<typeof import('sharp')>['default'];

let loading: Promise<Sharp> | null = null;

export function loadSharp(): Promise<Sharp> {
  loading ??= import('sharp').then(
    (m) => m.default,
    (e) => {
      loading = null; // retry on the next call instead of caching the failure
      throw e;
    },
  );
  return loading;
}
