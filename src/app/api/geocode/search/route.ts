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
 * Upstream: OpenStreetMap Nominatim (free, no key), hard-filtered to South
 * Africa (the marketplace's courier coverage). Server-side proxy so the
 * required Nominatim User-Agent policy is honoured, responses are cached
 * (identical queries hit the cache, not OSM) and per-IP rate limiting keeps
 * usage within Nominatim's public policy (max 1 req/s upstream — the cache +
 * debounce cover this for real traffic). Graceful degradation: upstream
 * failure returns an empty list, never an error toast on the client.
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const UA = 'GreenGateMarket/1.0 (https://greengatemarket.store; marketplace address autocomplete)';
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 500;

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

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  if (q.length < 3 || q.length > 120) {
    return Response.json({ suggestions: [] });
  }

  // Suggestion typing is chatty — rate-limit per IP, not per user.
  const rl = rateLimit(`geocode:${clientIp(req)}`, 40, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const key = q.toLowerCase();
  const cached = cacheGet(key);
  if (cached) {
    return Response.json({ suggestions: cached }, { headers: { 'Cache-Control': 'private, max-age=60' } });
  }

  try {
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
    if (!res.ok) {
      return Response.json({ suggestions: cacheGet(key) ?? [] });
    }
    const hits = (await res.json()) as NominatimHit[];
    const suggestions = hits
      .map(toSuggestion)
      .filter((s): s is AddressSuggestion => s !== null);
    cacheSet(key, suggestions);
    return Response.json({ suggestions }, { headers: { 'Cache-Control': 'private, max-age=60' } });
  } catch (e) {
    // Graceful: the form keeps working — the user simply types the address.
    console.error('geocode search error:', e instanceof Error ? e.message : e);
    return Response.json({ suggestions: cacheGet(key) ?? [] });
  }
}
