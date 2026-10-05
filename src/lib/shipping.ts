import type { ShippingOption } from './types';

/**
 * Courier rates. The Courier Guy live API is attempted first; if it is
 * unreachable the marketplace falls back to a transparent flat-rate table so
 * checkout never blocks.
 */

const TCG_KEY = process.env.COURIER_GUY_API_KEY ?? '';
const TCG_BASE = 'https://api.thecourierguy.co.za';

export const FALLBACK_RATES: ShippingOption[] = [
  { code: 'economy', label: 'Economy courier', eta: '5–7 business days', price: 45, provider: 'standard' },
  { code: 'standard', label: 'Standard courier', eta: '2–4 business days', price: 75, provider: 'standard' },
  { code: 'express', label: 'Express courier', eta: '1–2 business days', price: 130, provider: 'standard' },
];

async function fetchCourierGuyRates(origin: string, destination: string, weightKg: number): Promise<ShippingOption[] | null> {
  if (!TCG_KEY) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${TCG_BASE}/rates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TCG_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        origin: { location: origin },
        destination: { location: destination },
        parcels: [{ weight: weightKg, length: 30, width: 25, height: 15 }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ service_code?: string; service_name?: string; price?: number; eta?: string }>;
    if (!Array.isArray(data) || data.length === 0) return null;
    return data.slice(0, 3).map((r, i) => ({
      code: r.service_code ?? `tcg_${i}`,
      label: r.service_name ?? 'The Courier Guy',
      eta: r.eta ?? '2–4 business days',
      price: Number(r.price ?? 75),
      provider: 'thecourierguy',
    }));
  } catch {
    return null;
  }
}

export async function getShippingRates(params: { sellerLocation: string; buyerAddress: string; weightKg?: number }): Promise<ShippingOption[]> {
  const live = await fetchCourierGuyRates(params.sellerLocation, params.buyerAddress, params.weightKg ?? 1);
  return live ?? FALLBACK_RATES;
}

export function rateByCode(code: string): ShippingOption {
  return FALLBACK_RATES.find((r) => r.code === code) ?? FALLBACK_RATES[1];
}
