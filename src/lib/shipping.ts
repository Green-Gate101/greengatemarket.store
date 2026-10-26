/**
 * Courier rates. The Courier Guy live API (their Ship Logic v2 gateway,
 * api.portal.thecourierguy.co.za — verified live against af-south-1) is
 * attempted first; if it is unreachable or an address cannot be mapped to a
 * South African city, the marketplace falls back to a transparent flat-rate
 * table so checkout never blocks.
 */

/** Internal quote in rands; the public ShippingOption DTO carries cents. */
export interface RateQuote {
  code: string;
  label: string;
  eta: string;
  price: number;
  provider: string;
}

const TCG_BASE = 'https://api.portal.thecourierguy.co.za';
/**
 * TCG's public prepaid rate card — live city-pair quotes work without any
 * credential. A merchant Access Token (COURIER_GUY_API_KEY) is only needed to
 * switch to that merchant's own negotiated rates, and for label creation.
 */
const TCG_ACCOUNT_ID = Number(process.env.COURIER_GUY_ACCOUNT_ID ?? '') || 12345;
const TCG_KEY = process.env.COURIER_GUY_API_KEY ?? '';

export const FALLBACK_RATES: RateQuote[] = [
  { code: 'economy', label: 'Economy courier', eta: '5–7 business days', price: 45, provider: 'standard' },
  { code: 'standard', label: 'Standard courier', eta: '2–4 business days', price: 75, provider: 'standard' },
  { code: 'express', label: 'Express courier', eta: '1–2 business days', price: 130, provider: 'standard' },
];

/** Ship Logic v2 ShippingAddress — city is what pricing keys on; the rest aids routing.
 *  latitude/longitude are accepted by the gateway (verified live) when we hold the buyer's GPS pin. */
interface TcgAddress {
  street_address: string;
  local_area: string;
  city: string;
  zone: string;
  country: string;
  code: string;
  latitude?: number;
  longitude?: number;
}

const SA_PROVINCES = [
  'Western Cape', 'Gauteng', 'KwaZulu-Natal', 'Eastern Cape', 'Free State',
  'Mpumalanga', 'Limpopo', 'North West', 'Northern Cape',
];

/** City → province lookup (lower-cased keys) covering SA's main trading cities. */
const CITY_ZONES: Record<string, string> = {
  'cape town': 'Western Cape', 'stellenbosch': 'Western Cape', 'paarl': 'Western Cape',
  'george': 'Western Cape', 'bellville': 'Western Cape', 'somerset west': 'Western Cape',
  'johannesburg': 'Gauteng', 'pretoria': 'Gauteng', 'centurion': 'Gauteng', 'midrand': 'Gauteng',
  'sandton': 'Gauteng', 'soweto': 'Gauteng', 'benoni': 'Gauteng', 'boksburg': 'Gauteng',
  'roodepoort': 'Gauteng', 'krugersdorp': 'Gauteng', 'vereeniging': 'Gauteng',
  'durban': 'KwaZulu-Natal', 'pietermaritzburg': 'KwaZulu-Natal', 'richards bay': 'KwaZulu-Natal', 'newcastle': 'KwaZulu-Natal',
  'port elizabeth': 'Eastern Cape', 'gqeberha': 'Eastern Cape', 'east london': 'Eastern Cape', 'mthatha': 'Eastern Cape',
  'bloemfontein': 'Free State', 'welkom': 'Free State', 'sasolburg': 'Free State',
  'nelspruit': 'Mpumalanga', 'mbombela': 'Mpumalanga', 'witbank': 'Mpumalanga', 'emalahleni': 'Mpumalanga',
  'polokwane': 'Limpopo', 'tzaneen': 'Limpopo',
  'kimberley': 'Northern Cape', 'upington': 'Northern Cape',
  'rustenburg': 'North West', 'potchefstroom': 'North West', 'mahikeng': 'North West',
};

/**
 * Maps a free-text South African address ("10 Long St, Gardens, Cape Town, 8001"
 * or "Cape Town, Gardens") onto the Ship Logic address shape. Returns null when
 * no city + province can be established — the caller then uses the flat-rate
 * table instead of guessing.
 */
function parseSaAddress(raw: string): TcgAddress | null {
  const text = raw.trim();
  if (text.length < 4) return null;
  const lower = text.toLowerCase();
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  const code = text.match(/(?:^|[,\s])(\d{4})(?:[,\s]|$)/)?.[1] ?? '';
  const zoneFromText = SA_PROVINCES.find((p) => lower.includes(p.toLowerCase())) ?? '';
  const knownCity = Object.keys(CITY_ZONES).find((c) => lower.includes(c));
  const city = knownCity
    ?? (zoneFromText
      ? parts.find((p) => {
          const pl = p.toLowerCase();
          return pl !== zoneFromText.toLowerCase() && !/^\d{4}$/.test(p) && p.length >= 4;
        })
      : undefined)
    ?? '';
  const zone = zoneFromText || (knownCity ? CITY_ZONES[knownCity] : '');
  if (!city || !zone) return null;
  const street = parts[0] && parts[0].toLowerCase() !== city.toLowerCase() ? parts[0] : city;
  const localArea = parts.slice(1).find((p) => {
    const pl = p.toLowerCase();
    return pl !== city.toLowerCase() && pl !== zone.toLowerCase() && p !== code;
  }) ?? '';
  const titleCase = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase());
  return {
    street_address: street.slice(0, 120),
    local_area: localArea.slice(0, 80),
    city: titleCase(city).slice(0, 80),
    zone,
    country: 'ZA',
    code,
  };
}

interface TcgRateResponse {
  rates?: Array<{
    rate?: number;
    service_level?: { code?: string; name?: string; description?: string };
  }>;
}

/**
 * Ship Logic also accepts latitude/longitude on address objects (verified live
 * against the gateway: accepted, rates identical) — the pin helps their
 * geocoder disambiguate the exact doorstep. City text stays REQUIRED for
 * pricing (a pin alone yields "could not geocode delivery address"), so
 * coordinates are always supplementary here, never a replacement.
 */
function withPin(address: TcgAddress, lat?: number, lng?: number): TcgAddress {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return address;
  return { ...address, latitude: Number(lat.toFixed(6)), longitude: Number(lng.toFixed(6)) };
}

/**
 * Server-side reverse geocode for pins whose text address is unusable (e.g.
 * the buyer checked out from a raw "GPS -26.2, 28.0" line because the browser
 * geocoder failed). Nominatim with a proper User-Agent per their usage policy;
 * returns null on any failure — the caller then keeps the flat-rate fallback,
 * exactly like today, so checkout NEVER blocks.
 */
async function reverseGeocodeServer(lat: number, lng: number): Promise<{ street: string; city: string; zone: string; code: string } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&countrycodes=za`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6_000),
      headers: { 'User-Agent': 'GreenGateMarketplace/1.0 (delivery quoting)', Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      address?: { house_number?: string; road?: string; suburb?: string; city?: string; town?: string; village?: string; state?: string; postcode?: string };
    };
    const a = j.address ?? {};
    const city = a.city || a.town || a.village || a.suburb || '';
    if (!city) return null;
    return {
      street: [a.house_number, a.road].filter(Boolean).join(' ') || city,
      city,
      zone: a.state || '',
      code: a.postcode || '',
    };
  } catch {
    return null;
  }
}

/**
 * A parcel exactly as the seller declared it: what the item physically ships
 * in. The Courier Guy prices on the greater of actual vs volumetric weight
 * (L×W×H / 5000), so both numbers matter for an accurate charge.
 */
export interface ParcelSpec {
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

/** Clamp a seller-declared value into the gateway's accepted envelope. */
function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

/** Max parcels per quote — realistic carts are far below this; anything above
 * 20 units is quoted on the first 20 so the gateway payload stays sane. */
const MAX_PARCELS = 20;

function tcgParcels(parcels: ParcelSpec[] | undefined, fallbackWeightKg: number) {
  const list = (parcels ?? []).slice(0, MAX_PARCELS);
  if (list.length === 0) {
    // Legacy shape: a single parcel with the historical 30×25×15 default.
    return [
      {
        submitted_length_cm: 30,
        submitted_width_cm: 25,
        submitted_height_cm: 15,
        submitted_weight_kg: Math.round(Math.max(0.1, fallbackWeightKg) * 10) / 10,
      },
    ];
  }
  return list.map((p) => ({
    submitted_length_cm: Math.round(clamp(p.lengthCm, 1, 200)),
    submitted_width_cm: Math.round(clamp(p.widthCm, 1, 200)),
    submitted_height_cm: Math.round(clamp(p.heightCm, 1, 200)),
    submitted_weight_kg: Math.round(clamp(p.weightKg, 0.1, 100) * 10) / 10,
  }));
}

async function fetchCourierGuyRates(
  origin: string,
  destination: string,
  weightKg: number,
  buyerLat?: number,
  buyerLng?: number,
  parcels?: ParcelSpec[],
): Promise<RateQuote[] | null> {
  const collection = parseSaAddress(origin);
  // A pin is more reliable than free text: when the typed address cannot be
  // mapped but we hold the buyer's GPS fix, reverse-geocode it server-side so
  // The Courier Guy still prices a REAL address instead of us falling back to
  // flat rates.
  let delivery = parseSaAddress(destination);
  if (!delivery && typeof buyerLat === 'number' && typeof buyerLng === 'number' && Number.isFinite(buyerLat) && Number.isFinite(buyerLng)) {
    const fromPin = await reverseGeocodeServer(buyerLat, buyerLng);
    if (fromPin) {
      const titleCase = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase());
      delivery = {
        street_address: fromPin.street.slice(0, 120),
        local_area: '',
        city: titleCase(fromPin.city).slice(0, 80),
        zone: fromPin.zone || CITY_ZONES[fromPin.city.toLowerCase()] || '',
        country: 'ZA',
        code: fromPin.code,
      };
      // Zone missing after the geocode: derive it from the known city table.
      if (!delivery.zone) {
        const zone = Object.entries(CITY_ZONES).find(([c]) => fromPin.city.toLowerCase().includes(c))?.[1];
        delivery.zone = zone ?? '';
      }
    }
  }
  if (!delivery) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6500);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Optional merchant Access Token: switches from the public prepaid rate
    // card to the merchant's negotiated rates. Never sent when unset — an
    // invalid token would make the gateway reject otherwise-public quotes.
    if (TCG_KEY) headers.Authorization = `Bearer ${TCG_KEY}`;
    const { trackApiUsage } = await import('@/lib/usage');
    trackApiUsage('courier_guy');
    const res = await fetch(`${TCG_BASE}/v2/rates`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        account_id: TCG_ACCOUNT_ID,
        collection_address: collection,
        delivery_address: withPin(delivery, buyerLat, buyerLng),
        parcels: tcgParcels(parcels, weightKg),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as TcgRateResponse;
    const rates = (Array.isArray(data.rates) ? data.rates : []).filter(
      (r) => typeof r.rate === 'number' && r.rate > 0 && r.service_level?.code,
    );
    if (rates.length === 0) return null;
    return rates
      .sort((a, b) => (a.rate ?? 0) - (b.rate ?? 0))
      .slice(0, 3)
      .map((r) => ({
        code: `tcg_${String(r.service_level?.code).toLowerCase()}`,
        label: r.service_level?.name ?? 'The Courier Guy',
        eta: tcgEta(r.service_level?.name ?? '', r.service_level?.description ?? ''),
        price: Number(r.rate),
        provider: 'thecourierguy',
      }));
  } catch {
    return null;
  }
}

/** Buyer-facing delivery time from TCG's service description: the sentence
 * that talks about delivery — never a booking instruction meant for the
 * sender (the Same Day description starts with "kindly book your shipment
 * before 14:00"). */
export function tcgEta(name: string, description: string): string {
  const sentences = description.split('. ').map((s) => s.trim()).filter(Boolean);
  const delivery = sentences.find((s) => /deliver|business day/i.test(s));
  if (delivery) return delivery;
  if (/same\s*day/i.test(name)) return 'Same day, when the seller books before 14:00';
  if (/overnight/i.test(name)) return 'Next business day';
  return '2–4 business days';
}

export async function getShippingRates(params: {
  sellerLocation: string;
  buyerAddress: string;
  weightKg?: number;
  buyerLat?: number;
  buyerLng?: number;
  /** Real seller-declared parcels — sent to The Courier Guy verbatim so the
   * charge reflects the actual weight and box size. Absent = legacy default. */
  parcels?: ParcelSpec[];
}): Promise<RateQuote[]> {
  const live = await fetchCourierGuyRates(params.sellerLocation, params.buyerAddress, params.weightKg ?? 1, params.buyerLat, params.buyerLng, params.parcels);
  return live ?? FALLBACK_RATES;
}

export function rateByCode(code: string): RateQuote {
  return FALLBACK_RATES.find((r) => r.code === code) ?? FALLBACK_RATES[1];
}
