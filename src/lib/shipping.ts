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

/** Ship Logic v2 ShippingAddress — city is what pricing keys on; the rest aids routing. */
interface TcgAddress {
  street_address: string;
  local_area: string;
  city: string;
  zone: string;
  country: string;
  code: string;
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

async function fetchCourierGuyRates(origin: string, destination: string, weightKg: number): Promise<RateQuote[] | null> {
  const collection = parseSaAddress(origin);
  const delivery = parseSaAddress(destination);
  if (!collection || !delivery) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6500);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Optional merchant Access Token: switches from the public prepaid rate
    // card to the merchant's negotiated rates. Never sent when unset — an
    // invalid token would make the gateway reject otherwise-public quotes.
    if (TCG_KEY) headers.Authorization = `Bearer ${TCG_KEY}`;
    const res = await fetch(`${TCG_BASE}/v2/rates`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        account_id: TCG_ACCOUNT_ID,
        collection_address: collection,
        delivery_address: delivery,
        parcels: [
          {
            submitted_length_cm: 30,
            submitted_width_cm: 25,
            submitted_height_cm: 15,
            submitted_weight_kg: Math.round(Math.max(0.1, weightKg) * 10) / 10,
          },
        ],
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
        eta: (r.service_level?.description ?? '').split('. ')[0] || '2–4 business days',
        price: Number(r.rate),
        provider: 'thecourierguy',
      }));
  } catch {
    return null;
  }
}

export async function getShippingRates(params: { sellerLocation: string; buyerAddress: string; weightKg?: number }): Promise<RateQuote[]> {
  const live = await fetchCourierGuyRates(params.sellerLocation, params.buyerAddress, params.weightKg ?? 1);
  return live ?? FALLBACK_RATES;
}

export function rateByCode(code: string): RateQuote {
  return FALLBACK_RATES.find((r) => r.code === code) ?? FALLBACK_RATES[1];
}
