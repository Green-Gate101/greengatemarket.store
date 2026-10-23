/**
 * Algolia product indexing + search.
 * Indexing uses the write (admin) key. Queries prefer the optional
 * least-privilege search key (ALGOLIA_SEARCH_KEY) and fall back to the admin
 * key when it is absent, so existing deployments behave exactly as before.
 * Every call is guarded: when Algolia is unreachable the storefront falls
 * back to direct database search.
 */

const APP_ID = process.env.ALGOLIA_APP_ID ?? '';
const ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY ?? '';
const SEARCH_KEY = process.env.ALGOLIA_SEARCH_KEY || ADMIN_KEY;
const INDEX = process.env.ALGOLIA_INDEX_NAME ?? 'products';

export const algoliaConfigured = Boolean(APP_ID && ADMIN_KEY);

interface AlgoliaHit {
  objectID: string;
}

async function algoliaRequest<T>(method: string, path: string, body?: unknown, apiKey: string = ADMIN_KEY): Promise<T> {
  const { trackApiUsage } = await import('@/lib/usage');
  trackApiUsage('algolia');
  const res = await fetch(`https://${APP_ID}-dsn.algolia.net/1${path}`, {
    method,
    headers: {
      'x-algolia-application-id': APP_ID,
      'x-algolia-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    // Hard 4s ceiling: search runs inside the public catalogue request path,
    // so a hung Algolia connection must never hold the response hostage —
    // the caller's database-search fallback already handles the rejection.
    signal: AbortSignal.timeout(4_000),
  });
  if (!res.ok) throw new Error(`Algolia ${method} ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export interface IndexedProduct {
  objectID: string;
  name: string;
  description: string;
  category: string;
  price: number;
  sellerName: string;
}

export async function indexProduct(product: IndexedProduct): Promise<void> {
  if (!algoliaConfigured) return;
  try {
    await algoliaRequest('PUT', `/indexes/${INDEX}/${product.objectID}`, product);
  } catch (e) {
    console.error('algolia indexProduct failed:', e instanceof Error ? e.message : e);
  }
}

export async function removeProduct(objectId: string): Promise<void> {
  if (!algoliaConfigured) return;
  try {
    await algoliaRequest('DELETE', `/indexes/${INDEX}/${encodeURIComponent(objectId)}`);
  } catch (e) {
    console.error('algolia removeProduct failed:', e instanceof Error ? e.message : e);
  }
}

export async function searchProductIds(query: string): Promise<string[] | null> {
  if (!algoliaConfigured || !query.trim()) return null;
  try {
    const data = await algoliaRequest<{ hits: AlgoliaHit[] }>('POST', `/indexes/${INDEX}/query`, {
      // Deep page size: the database still applies live availability/category
      // filters and pagination on the returned ids, so the index must not
      // truncate the candidate set below the catalogue size.
      params: `query=${encodeURIComponent(query)}&hitsPerPage=200`,
    }, SEARCH_KEY);
    return data.hits.map((h) => h.objectID);
  } catch (e) {
    console.error('algolia search failed:', e instanceof Error ? e.message : e);
    return null;
  }
}
