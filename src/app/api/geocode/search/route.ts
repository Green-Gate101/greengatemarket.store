import { NextRequest } from 'next/server';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Address autocomplete — the "type and we help you find it" search behind the
 * Google-Maps-style suggestions in the delivery-location forms.
 *
 * GET /api/geocode/search?q=12+long+street+cape+town
 *   → { suggestions: [{ id, line, main, secondary, street, city, province,
 *                       postalCode, latitude, longitude }] }
 *
 * Upstream: two free, no-key geocoders queried in parallel and merged —
 *   1. OpenStreetMap Nominatim (rich address parsing)
 *   2. Photon/Komoot (strong type-ahead matching — finds townships, rural
 *      villages, landmarks and informal names Nominatim misses)
 * Results are hard-filtered to South Africa (the marketplace's courier
 * coverage; Photon hits are filtered by returned countrycode). Server-side
 * proxy so the required Nominatim User-Agent policy is honoured, responses
 * are cached (identical queries hit the cache, not OSM) and per-IP rate
 * limiting keeps usage within public policy. Graceful degradation: if one
 * upstream fails the other still answers, and total failure returns an
 * empty list — never an error toast on the client.
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const PHOTON_URL = 'https://photon.komoot.io/api/';
const UA = 'GreenGateMarket/1.0 (https://greengatemarket.store; marketplace address autocomplete)';
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 500;
/** Found addresses are the same for every shopper typing the same text, so the
 *  edge keeps them (each server's own cache only helps that server) — far fewer
 *  calls to the free geocoders, which allow about one a second. Empty answers
 *  (possibly an upstream hiccup) are never shared. */
const FOUND_CACHE = 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400';

export interface AddressSuggestion {
  id: string;
  /** Full one-line address (country trimmed) shown as the suggestion. */
  line: string;
  /** Emphasised first part, e.g. "12 Long Street". */
  main: string;
  /** Context after the main part, e.g. "Cape Town City Centre, Cape Town, …". */
  secondary: string;
  street: string;
  city: string;
  province: string;
  postalCode: string;
  latitude: number;
  longitude: number;
}

const cache = new Map<string, { at: number; data: AddressSuggestion[] }>();

function cacheGet(key: string): AddressSuggestion[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key: string, data: AddressSuggestion[]) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Trim the oldest quarter — plenty for a suggestion cache.
    const drop = Math.ceil(CACHE_MAX_ENTRIES / 4);
    const keys = cache.keys();
    for (let i = 0; i < drop; i++) {
      const k = keys.next();
      if (k.done) break;
      cache.delete(k.value);
    }
  }
  cache.set(key, { at: Date.now(), data });
}

interface NominatimHit {
  place_id?: number;
  osm_type?: string;
  osm_id?: number;
  name?: string;
  display_name?: string;
  lat?: string;
  lon?: string;
  address?: {
    house_number?: string;
    road?: string;
    pedestrian?: string;
    footway?: string;
    suburb?: string;
    city_district?: string;
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    state?: string;
    province?: string;
    postcode?: string;
  };
}

function toSuggestion(h: NominatimHit): AddressSuggestion | null {
  if (!h.display_name || !h.lat || !h.lon) return null;
  const a = h.address ?? {};
  const street = [a.house_number, a.road ?? a.pedestrian ?? a.footway].filter(Boolean).join(' ');
  const city = a.city || a.town || a.village || a.suburb || a.municipality || a.city_district || '';
  const province = a.province || a.state || '';
  const postalCode = a.postcode || '';
  const latitude = Number(h.lat);
  const longitude = Number(h.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  // display_name ends with ", South Africa" — trim it for a cleaner line.
  const line = h.display_name.replace(/,?\s*South Africa\s*$/, '').trim();
  const parts = line.split(',').map((s) => s.trim()).filter(Boolean);
  const main = (h.name && h.name !== line ? h.name : parts[0]) || line;
  const secondary = parts.slice(1).join(', ');

  return {
    id: `${h.osm_type ?? 'n'}${h.osm_id ?? h.place_id ?? `${latitude},${longitude}`}`,
    line,
    main,
    secondary,
    street,
    city,
    province,
    postalCode,
    latitude,
    longitude,
  };
}

// ---------------------------------------------------------------- Photon ----
// photon.komoot.io — free, no key, excellent partial/type-ahead matching.
// Returns GeoJSON: features[].geometry.coordinates = [lng, lat], with the
// address parts in features[].properties (including countrycode, "ZA").
interface PhotonHit {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    osm_id?: number;
    osm_type?: 'N' | 'W' | 'R';
    name?: string;
    housenumber?: string;
    street?: string;
    district?: string;
    locality?: string;
    county?: string;
    city?: string;
    state?: string;
    postcode?: string;
    countrycode?: string;
  };
}

function toPhotonSuggestion(h: PhotonHit): AddressSuggestion | null {
  const p = h.properties;
  const coords = h.geometry?.coordinates;
  if (!p || !coords || coords.length !== 2) return null;
  // Hard country filter (Photon has no countrycodes query param).
  if (p.countrycode !== 'ZA') return null;
  const latitude = coords[1];
  const longitude = coords[0];
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const city = p.city || p.district || p.locality || p.county || '';
  const province = p.state || '';
  const postalCode = p.postcode || '';

  // Build a clean one-line display: primary name first, then locality
  // context — de-duplicated case-insensitively (Photon often repeats the
  // name in city/state for places).
  const primary = p.name || street || city;
  if (!primary) return null;
  const seen = new Set<string>([primary.toLowerCase()]);
  const rest: string[] = [];
  for (const part of [street, p.district, p.city, p.county, province, postalCode]) {
    const v = (part ?? '').trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    rest.push(v);
  }
  const line = [primary, ...rest].join(', ');

  return {
    id: `p${p.osm_type ?? 'n'}${p.osm_id ?? `${latitude.toFixed(5)},${longitude.toFixed(5)}`}`,
    line,
    main: primary,
    secondary: rest.join(', '),
    street,
    city,
    province,
    postalCode,
    latitude,
    longitude,
  };
}

/** Merge helper: Nominatim results keep priority; Photon fills the gaps.
 *  Dedupe by ~110 m coordinate grid and by normalised display line. */
function mergeSuggestions(primary: AddressSuggestion[], secondary: AddressSuggestion[]): AddressSuggestion[] {
  const seen = new Set<string>();
  const out: AddressSuggestion[] = [];
  for (const s of [...primary, ...secondary]) {
    const coordKey = `${s.latitude.toFixed(3)},${s.longitude.toFixed(3)}`;
    const lineKey = s.line.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(coordKey) || seen.has(`L:${lineKey}`)) continue;
    seen.add(coordKey);
    seen.add(`L:${lineKey}`);
    out.push(s);
  }
  return out.slice(0, 8);
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  if (q.length < 3 || q.length > 120) {
    return Response.json({ suggestions: [] });
  }

  // Suggestion typing is chatty — rate-limit per IP, not per user. Generous:
  // mobile networks put many shoppers behind one IP (carrier NAT).
  const rl = rateLimit(`geocode:${clientIp(req)}`, 120, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const key = q.toLowerCase();
  const cached = cacheGet(key);
  if (cached) {
    return Response.json({ suggestions: cached }, { headers: { 'Cache-Control': FOUND_CACHE } });
  }

  // Both providers in parallel; each independent — one failing never
  // blocks the other (allSettled + graceful empty lists).
  // Usage metering is best-effort too — a failed dynamic import must never
  // turn a geocode lookup into a 500.
  try {
    const { trackApiUsage } = await import('@/lib/usage');
    trackApiUsage('geocode');
  } catch {
    // metering is optional; geocode continues
  }
  const [nominatimRes, photonRes] = await Promise.allSettled([
    (async () => {
      const url = new URL(NOMINATIM_URL);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('q', q);
      url.searchParams.set('addressdetails', '1');
      url.searchParams.set('limit', '6');
      url.searchParams.set('countrycodes', 'za');
      url.searchParams.set('accept-language', 'en');
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(6_000),
      });
      if (!res.ok) return [];
      const hits = (await res.json()) as NominatimHit[];
      return hits.map(toSuggestion).filter((s): s is AddressSuggestion => s !== null);
    })(),
    (async () => {
      const url = new URL(PHOTON_URL);
      url.searchParams.set('q', q);
      url.searchParams.set('limit', '8');
      url.searchParams.set('lang', 'en');
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { features?: PhotonHit[] };
      return (data.features ?? [])
        .map(toPhotonSuggestion)
        .filter((s): s is AddressSuggestion => s !== null);
    })(),
  ]);

  const fromNominatim = nominatimRes.status === 'fulfilled' ? nominatimRes.value : [];
  const fromPhoton = photonRes.status === 'fulfilled' ? photonRes.value : [];

  if (fromNominatim.length === 0 && fromPhoton.length === 0) {
    // Both upstreams dead or nothing found — fall back to any stale cache
    // entry, else an empty list (the form still works by typing).
    const stale = cacheGet(key);
    if (stale && stale.length > 0) {
      return Response.json({ suggestions: stale }, { headers: { 'Cache-Control': 'private, max-age=60' } });
    }
    if (nominatimRes.status === 'rejected' || photonRes.status === 'rejected') {
      console.error('geocode search error:',
        nominatimRes.status === 'rejected' ? String(nominatimRes.reason).slice(0, 200) : 'nominatim empty',
        '/',
        photonRes.status === 'rejected' ? String(photonRes.reason).slice(0, 200) : 'photon empty');
    }
    return Response.json({ suggestions: [] }, { headers: { 'Cache-Control': 'private, max-age=30' } });
  }

  const suggestions = mergeSuggestions(fromNominatim, fromPhoton);
  cacheSet(key, suggestions);
  return Response.json({ suggestions }, { headers: { 'Cache-Control': FOUND_CACHE } });
}
