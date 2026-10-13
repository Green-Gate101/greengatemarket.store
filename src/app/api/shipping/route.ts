import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { getShippingRates } from '@/lib/shipping';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Delivery quote — calculated server-side only (spec #72). Prices in cents.
 *
 * When the caller supplies cart `items`, the real parcels are built here from
 * what each seller declared for their product (weight + box size) — The
 * Courier Guy is quoted on the ACTUAL shipment, so the charge is right. The
 * client can never inflate or deflate a quote: everything is read from the
 * database, quantities are capped, and malformed ids are skipped.
 */
export async function POST(req: NextRequest) {
  try {
    const rl = rateLimit(`shipping:${clientIp(req)}`, 30, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    await bootstrap();
    const body = (await req.json()) as {
      sellerLocation?: string;
      address?: string;
      weightGrams?: number;
      latitude?: number;
      longitude?: number;
      items?: { productId?: string; variantId?: string; quantity?: number }[];
    };
    const sellerLocation = String(body.sellerLocation ?? '').trim();
    const address = String(body.address ?? '').trim();
    if (address.length < 5) return Response.json({ error: 'Enter a delivery address first.' }, { status: 400 });
    // The buyer's GPS pin when captured — handed straight to The Courier Guy's
    // rate gateway alongside the text address (optional; absent = text-only).
    const latitude = Number.isFinite(body.latitude) ? Number(body.latitude) : undefined;
    const longitude = Number.isFinite(body.longitude) ? Number(body.longitude) : undefined;

    // Build real parcels from the sellers' declarations (server-side source of
    // truth — the buyer's client never dictates weight or size). One parcel per
    // unit; capped so huge carts stay within the gateway's envelope.
    const parcels: { weightKg: number; lengthCm: number; widthCm: number; heightCm: number }[] = [];
    const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
    for (const item of items) {
      const productId = String(item?.productId ?? '');
      const quantity = Math.min(20, Math.max(1, Math.floor(Number(item?.quantity) || 1)));
      if (!productId) continue;
      const product = await db.product.findUnique({
        where: { id: productId },
        select: { weightGrams: true, lengthCm: true, widthCm: true, heightCm: true },
      });
      if (!product) continue;
      for (let i = 0; i < quantity; i++) {
        parcels.push({
          weightKg: Math.max(0.1, product.weightGrams / 1000),
          lengthCm: product.lengthCm,
          widthCm: product.widthCm,
          heightCm: product.heightCm,
        });
      }
    }

    const rates = await getShippingRates({
      sellerLocation,
      buyerAddress: address,
      weightKg: Math.max(0.1, (Number(body.weightGrams) || 1000) / 1000),
      buyerLat: latitude,
      buyerLng: longitude,
      parcels: parcels.length > 0 ? parcels : undefined,
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
