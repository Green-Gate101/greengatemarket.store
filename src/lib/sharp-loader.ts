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
// sharp's ESM entry exposes a callable default export; depending on the type
// resolution (sharp's own types vs @types/sharp vs CJS interop) the `default`
// property may or may not exist on the module type — accept whichever shape.
type SharpModule = typeof import('sharp');
type Sharp = SharpModule extends { default: infer S } ? S : SharpModule;

let loading: Promise<Sharp> | null = null;

export function loadSharp(): Promise<Sharp> {
  loading ??= import('sharp').then(
    // `default` covers normal ESM/CJS interop; some type resolutions expose
    // sharp as a bare namespace, so fall back to the namespace itself.
    (m) => (('default' in m ? m.default : m) as Sharp),
    (e) => {
      loading = null; // retry on the next call instead of caching the failure
      throw e;
    },
  );
  return loading;
}
