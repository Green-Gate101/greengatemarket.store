/**
 * The Courier Guy (TCG) — full API client for the marketplace's own courier
 * account. Base: https://api.portal.thecourierguy.co.za (Bearer token auth via
 * COURIER_GUY_API_KEY, verified live against the gateway).
 *
 * Endpoints used (from TCG's official Postman collection, all verified live):
 *  - POST /rates                    → service quotes for the exact parcels
 *  - POST /shipments                → book a collection + delivery, get the
 *                                     tracking reference + waybill
 *  - GET  /tracking/shipments       → live tracking events
 *  - GET  /shipments?tracking_reference=… → shipment status
 *  - GET  /shipments/label?id=…     → the waybill PDF (seller prints it)
 *  - POST /shipments/cancel         → cancel a booked shipment
 *
 * DESIGN RULES (never fail checkout or payment):
 *  - every call is timeout-bounded and catch-all; callers receive a result
 *    object, never a throw.
 *  - TCG answers errors as PLAIN TEXT bodies (e.g. "insufficient funds for
 *    the account") — the parser treats non-JSON bodies as the error message.
 *  - booking never fires for pickup-point orders (PAXI / Pudo) — those are
 *    not TCG shipments.
 */

const TCG_BASE = 'https://api.portal.thecourierguy.co.za';
const TCG_KEY = process.env.COURIER_GUY_API_KEY ?? '';

export function tcgConfigured(): boolean {
  return TCG_KEY.length > 0;
}

function authHeaders(json = true): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${TCG_KEY}` };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

/**
 * One bounded TCG call. Returns parsed JSON when the body is JSON, otherwise
 * the trimmed text (TCG sends human-readable errors as plain text with 4xx).
 */
async function tcgCall(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs?: number },
): Promise<{ ok: boolean; status: number; json?: unknown; text?: string }> {
  if (!TCG_KEY) return { ok: false, status: 0, text: 'The Courier Guy API key is not configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 9_000);
  try {
    const res = await fetch(`${TCG_BASE}${path}`, {
      method: init.method,
      headers: authHeaders(init.body !== undefined),
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const raw = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const reason = parsed !== undefined ? snippet(parsed) : raw.trim().slice(0, 200) || `HTTP ${res.status}`;
      return { ok: false, status: res.status, text: reason, json: parsed };
    }
    return { ok: true, status: res.status, json: parsed, text: parsed === undefined ? raw : undefined };
  } catch (e) {
    return { ok: false, status: 0, text: e instanceof Error ? e.message : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

function snippet(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.slice(0, 200);
  } catch {
    return 'unparsable response';
  }
}

// ---------------------------------------------------------------------------
// Addresses — TCG's Ship Logic address shape
// ---------------------------------------------------------------------------

export interface TcgAddress {
  type: 'business' | 'residential';
  company: string;
  street_address: string;
  local_area: string;
  city: string;
  zone: string;
  country: string;
  code: string;
  lat?: number;
  lng?: number;
}

const titleCase = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase());

/** Build the seller's COLLECTION address from the store's own records. */
export function storeCollectionAddress(store: {
  name: string;
  location: string;
  streetAddress?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
}): TcgAddress | null {
  const street = store.streetAddress?.trim();
  const city = store.city?.trim();
  if (street && city) {
    return {
      type: 'business',
      company: store.name.slice(0, 80),
      street_address: street.slice(0, 120),
      local_area: '',
      city: titleCase(city).slice(0, 80),
      zone: store.province?.trim() ?? '',
      country: 'ZA',
      code: store.postalCode?.trim() ?? '',
    };
  }
  // Fall back to the free-text location (same parser the live quotes use).
  const parsed = parseSaAddressLoose(store.location);
  if (!parsed) return null;
  return { type: 'business', company: store.name.slice(0, 80), ...parsed };
}

/** Minimal SA free-text address mapper (mirrors src/lib/shipping.ts). */
function parseSaAddressLoose(raw: string): Omit<TcgAddress, 'type' | 'company'> | null {
  const text = (raw ?? '').trim();
  if (text.length < 4) return null;
  const lower = text.toLowerCase();
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  const code = text.match(/(?:^|[,\s])(\d{4})(?:[,\s]|$)/)?.[1] ?? '';
  const ZONES = [
    'Western Cape', 'Gauteng', 'KwaZulu-Natal', 'Eastern Cape', 'Free State',
    'Mpumalanga', 'Limpopo', 'North West', 'Northern Cape',
  ];
  const CITY_ZONES: Record<string, string> = {
    'cape town': 'Western Cape', 'johannesburg': 'Gauteng', 'pretoria': 'Gauteng',
    'centurion': 'Gauteng', 'midrand': 'Gauteng', 'sandton': 'Gauteng',
    'durban': 'KwaZulu-Natal', 'pietermaritzburg': 'KwaZulu-Natal',
    'port elizabeth': 'Eastern Cape', 'gqeberha': 'Eastern Cape', 'east london': 'Eastern Cape',
    'bloemfontein': 'Free State', 'nelspruit': 'Mpumalanga', 'mbombela': 'Mpumalanga',
    'polokwane': 'Limpopo', 'kimberley': 'Northern Cape', 'rustenburg': 'North West',
  };
  const zone = ZONES.find((z) => lower.includes(z.toLowerCase())) ?? '';
  const knownCity = Object.keys(CITY_ZONES).find((c) => lower.includes(c));
  const city = knownCity
    ?? (zone
      ? parts.find((p) => {
          const pl = p.toLowerCase();
          return pl !== zone.toLowerCase() && !/^\d{4}$/.test(p) && p.length >= 4;
        })
      : undefined)
    ?? '';
  if (!city) return null;
  const finalZone = zone || (knownCity ? CITY_ZONES[knownCity] : '');
  if (!finalZone) return null;
  const street = parts[0] && parts[0].toLowerCase() !== city.toLowerCase() ? parts[0] : city;
  const localArea = parts.slice(1).find((p) => {
    const pl = p.toLowerCase();
    return pl !== city.toLowerCase() && pl !== finalZone.toLowerCase() && p !== code;
  }) ?? '';
  return {
    street_address: street.slice(0, 120),
    local_area: localArea.slice(0, 80),
    city: titleCase(city).slice(0, 80),
    zone: finalZone,
    country: 'ZA',
    code,
  };
}

/** Build the buyer's DELIVERY address from the order (text + GPS pin). */
export function orderDeliveryAddress(
  address: string,
  lat: number | null,
  lng: number | null,
): TcgAddress | null {
  const parsed = parseSaAddressLoose(address);
  if (!parsed) return null;
  const out: TcgAddress = { type: 'residential', company: '', ...parsed };
  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
    out.lat = Number(lat.toFixed(6));
    out.lng = Number(lng.toFixed(6));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parcels
// ---------------------------------------------------------------------------

export interface ParcelSpec {
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

/** TCG parcel objects from the seller-declared specs (1 parcel per unit). */
export function tcgParcelObjects(
  parcels: ParcelSpec[],
  describe?: (index: number) => string | undefined,
): Array<Record<string, unknown>> {
  return parcels.slice(0, 20).map((p, i) => {
    const obj: Record<string, unknown> = {
      submitted_length_cm: Math.round(clamp(p.lengthCm, 1, 200)),
      submitted_width_cm: Math.round(clamp(p.widthCm, 1, 200)),
      submitted_height_cm: Math.round(clamp(p.heightCm, 1, 200)),
      submitted_weight_kg: Math.round(clamp(p.weightKg, 0.1, 100) * 10) / 10,
    };
    const desc = describe?.(i);
    if (desc) obj.parcel_description = desc.slice(0, 60);
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Rates (used to validate/pick the service at booking time)
// ---------------------------------------------------------------------------

interface TcgQuote {
  rate: number;
  code: string;
  name: string;
  id: number;
}

/** Fresh quotes for the exact shipment — lets booking pick a REAL service. */
export async function fetchRates(params: {
  collection: TcgAddress;
  delivery: TcgAddress;
  parcels: Array<Record<string, unknown>>;
  declaredValue?: number;
}): Promise<{ ok: true; quotes: TcgQuote[] } | { ok: false; reason: string }> {
  const body: Record<string, unknown> = {
    collection_address: params.collection,
    delivery_address: params.delivery,
    parcels: params.parcels,
  };
  if (params.declaredValue && params.declaredValue > 0) body.declared_value = params.declaredValue;
  const res = await tcgCall('/rates', { method: 'POST', body });
  if (!res.ok || res.json === undefined) {
    return { ok: false, reason: res.text ?? 'quote failed' };
  }
  const j = res.json as { rates?: Array<{ rate?: number; service_level?: { code?: string; name?: string; id?: number } }> };
  const quotes = (Array.isArray(j.rates) ? j.rates : [])
    .filter((r) => typeof r.rate === 'number' && r.rate > 0 && r.service_level?.code)
    .map((r) => ({ rate: r.rate as number, code: String(r.service_level?.code).toUpperCase(), name: String(r.service_level?.name ?? 'The Courier Guy'), id: Number(r.service_level?.id ?? 0) }));
  if (quotes.length === 0) return { ok: false, reason: 'no rates returned' };
  return { ok: true, quotes };
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

export interface BookingInput {
  collection: TcgAddress;
  delivery: TcgAddress;
  collectionContact: { name: string; mobile: string; email: string };
  deliveryContact: { name: string; mobile: string; email: string };
  parcels: Array<Record<string, unknown>>;
  /** e.g. "tcg_lpf" stored at checkout (null = cheapest available service). */
  serviceCode: string | null;
  declaredValueCents: number;
  customerReference: string;
  /** Business days before the courier should first attempt collection. */
  collectionInDays: number;
}

export type BookingResult =
  | { ok: true; shipmentId: number | null; trackingReference: string; serviceCode: string; price: number | null }
  | { ok: false; reason: string };

/**
 * Book a TCG shipment. Resilient by design: the requested service is
 * validated against a FRESH quote (the account's live prices), falling back
 * to the cheapest available service when the exact one is gone.
 */
export async function bookShipment(input: BookingInput): Promise<BookingResult> {
  if (!tcgConfigured()) return { ok: false, reason: 'The Courier Guy API key is not configured' };

  // Validate the service against a fresh quote; fall back to the cheapest.
  let serviceCode = (input.serviceCode ?? '').replace(/^tcg_/i, '').toUpperCase();
  const quoted = await fetchRates({
    collection: input.collection,
    delivery: input.delivery,
    parcels: input.parcels,
    declaredValue: Math.round(input.declaredValueCents / 100),
  });
  if (quoted.ok) {
    const match = quoted.quotes.find((q) => q.code === serviceCode);
    const chosen = match ?? quoted.quotes.slice().sort((a, b) => a.rate - b.rate)[0];
    serviceCode = chosen.code;
  }
  if (!serviceCode) return { ok: false, reason: quoted.ok ? 'no service available' : quoted.reason };

  const day = (offset: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    return `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
  };

  const body: Record<string, unknown> = {
    collection_address: input.collection,
    collection_contact: {
      name: input.collectionContact.name.slice(0, 80),
      mobile_number: input.collectionContact.mobile.slice(0, 30),
      email: input.collectionContact.email.slice(0, 120),
    },
    delivery_address: input.delivery,
    delivery_contact: {
      name: input.deliveryContact.name.slice(0, 80),
      mobile_number: input.deliveryContact.mobile.slice(0, 30),
      email: input.deliveryContact.email.slice(0, 120),
    },
    parcels: input.parcels,
    declared_value: Math.max(0, Math.round(input.declaredValueCents / 100)),
    collection_min_date: day(Math.max(1, input.collectionInDays)),
    delivery_min_date: day(Math.max(2, input.collectionInDays + 1)),
    customer_reference: input.customerReference.slice(0, 40),
    service_level_code: serviceCode,
    mute_notifications: true,
  };

  const res = await tcgCall('/shipments', { method: 'POST', body, timeoutMs: 15_000 });
  if (!res.ok || res.json === undefined) {
    return { ok: false, reason: res.text ?? 'booking failed' };
  }
  // Response shape (defensive): the shipment id and tracking reference may sit
  // at the top level or nested; TCG's gateway has used both across versions.
  const j = res.json as Record<string, unknown>;
  const ship = (j.shipment ?? j) as Record<string, unknown>;
  const first = Array.isArray(j.shipments) ? (j.shipments[0] as Record<string, unknown> | undefined) : undefined;
  const source = ship && typeof ship === 'object' ? ship : first ?? {};
  const rawId = source.id ?? source.shipment_id ?? first?.id;
  const rawRef = source.tracking_reference ?? source.trackingReference ?? source.reference ?? first?.tracking_reference;
  const shipmentId = typeof rawId === 'number' ? rawId : typeof rawId === 'string' && /^\d+$/.test(rawId) ? Number(rawId) : null;
  const trackingReference = typeof rawRef === 'string' && rawRef.trim() ? rawRef.trim() : '';
  if (shipmentId === null && !trackingReference) {
    console.error('tcg booking: unrecognised response shape', snippet(res.json));
    return { ok: false, reason: 'unexpected response from The Courier Guy' };
  }
  return { ok: true, shipmentId, trackingReference, serviceCode, price: null };
}

// ---------------------------------------------------------------------------
// Tracking / label / cancel
// ---------------------------------------------------------------------------

export interface TrackingEvent {
  at: string | null;
  status: string;
  description: string;
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

/** Normalised tracking events (shape-tolerant across TCG gateway versions). */
export async function getTracking(reference: string): Promise<{ ok: true; events: TrackingEvent[] } | { ok: false; reason: string }> {
  const res = await tcgCall(`/tracking/shipments?tracking_reference=${encodeURIComponent(reference)}`, { method: 'GET' });
  if (!res.ok) return { ok: false, reason: res.text ?? 'tracking unavailable' };
  const j = res.json as unknown;
  const list: unknown[] = Array.isArray(j)
    ? j
    : Array.isArray((j as { tracking?: unknown[] })?.tracking)
      ? (j as { tracking: unknown[] }).tracking
      : Array.isArray((j as { events?: unknown[] })?.events)
        ? (j as { events: unknown[] }).events
        : Array.isArray((j as { parcels?: unknown[] })?.parcels)
          ? (j as { parcels: unknown[] }).parcels
          : [];
  const events: TrackingEvent[] = list.map((raw) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const at = asText(e.date_time) || asText(e.datetime) || asText(e.timestamp) || asText(e.created_at) || asText(e.scanned_at) || asText(e.date) || null;
    const status = asText(e.status) || asText(e.status_code) || asText(e.event_type) || asText(e.tracking_status) || 'update';
    const description = asText(e.status_description) || asText(e.description) || asText(e.status_text) || asText(e.notes) || status;
    return { at, status, description };
  });
  return { ok: true, events };
}

/** The waybill PDF for a booked shipment (seller prints it). */
export async function getLabelPdf(shipmentId: number): Promise<{ ok: true; bytes: ArrayBuffer; contentType: string } | { ok: false; reason: string }> {
  if (!TCG_KEY) return { ok: false, reason: 'The Courier Guy API key is not configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${TCG_BASE}/shipments/label?id=${encodeURIComponent(String(shipmentId))}`, {
      method: 'GET',
      headers: authHeaders(false),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, reason: text.trim().slice(0, 200) || `HTTP ${res.status}` };
    }
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength === 0) return { ok: false, reason: 'empty label' };
    return { ok: true, bytes, contentType: res.headers.get('content-type') ?? 'application/pdf' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

/** Latest shipment status (GET /shipments?tracking_reference=…). */
export async function getShipmentStatus(reference: string): Promise<{ ok: true; status: string } | { ok: false; reason: string }> {
  const res = await tcgCall(`/shipments?tracking_reference=${encodeURIComponent(reference)}`, { method: 'GET' });
  if (!res.ok) return { ok: false, reason: res.text ?? 'status unavailable' };
  const j = res.json as Record<string, unknown>;
  const ship = (Array.isArray(j.shipments) ? (j.shipments[0] as Record<string, unknown> | undefined) : (j.shipment as Record<string, unknown> | undefined)) ?? j;
  const status = asText(ship.status) || asText(ship.shipment_status) || asText((ship.parcel as Record<string, unknown> | undefined)?.status);
  return status ? { ok: true, status } : { ok: false, reason: 'status not reported' };
}

/** Cancel a booked shipment (admin/ops action; also used by tests). */
export async function cancelShipment(reference: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const res = await tcgCall('/shipments/cancel', { method: 'POST', body: { tracking_reference: reference } });
  return res.ok ? { ok: true } : { ok: false, reason: res.text ?? 'cancel failed' };
}
