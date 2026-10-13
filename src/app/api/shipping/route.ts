import { NextRequest } from 'next/server';
import { getShippingRates } from '@/lib/shipping';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/** Delivery quote — calculated server-side only (spec #72). Prices in cents. */
export async function POST(req: NextRequest) {
  try {
    const rl = rateLimit(`shipping:${clientIp(req)}`, 30, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const body = (await req.json()) as { sellerLocation?: string; address?: string; weightGrams?: number; latitude?: number; longitude?: number };
    const sellerLocation = String(body.sellerLocation ?? '').trim();
    const address = String(body.address ?? '').trim();
    if (address.length < 5) return Response.json({ error: 'Enter a delivery address first.' }, { status: 400 });
    // The buyer's GPS pin when captured — handed straight to The Courier Guy's
    // rate gateway alongside the text address (optional; absent = text-only).
    const latitude = Number.isFinite(body.latitude) ? Number(body.latitude) : undefined;
    const longitude = Number.isFinite(body.longitude) ? Number(body.longitude) : undefined;

    const rates = await getShippingRates({
      sellerLocation,
      buyerAddress: address,
      weightKg: Math.max(0.1, (Number(body.weightGrams) || 1000) / 1000),
      buyerLat: latitude,
      buyerLng: longitude,
    });

    return Response.json({
      options: rates.map((r) => ({
        code: r.code,
        label: r.label,
        eta: r.eta,
        priceCents: Math.round(r.price * 100),
        provider: r.provider,
      })),
    });
  } catch (e) {
    console.error('shipping quote error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not calculate delivery. Please try again.' }, { status: 500 });
  }
}
