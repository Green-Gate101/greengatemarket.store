import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { getShippingRates, type ParcelSpec, type RateQuote } from '@/lib/shipping';
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
    // Generous per-IP ceiling: South African mobile carriers put many buyers
    // behind one IP (carrier NAT), and checkout quotes after each address edit.
    const rl = rateLimit(`shipping:${clientIp(req)}`, 90, 60_000);
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
    // Grouped PER STORE: every seller ships their own parcels from their own
    // town, and /api/checkout charges each store's order its own leg.
    const legs = new Map<string, { location: string; parcels: ParcelSpec[] }>();
    const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
    // One query for the whole cart (not one per line).
    const ids = [...new Set(items.map((item) => String(item?.productId ?? '')).filter(Boolean))];
    const products = ids.length > 0
      ? await db.product.findMany({
          where: { id: { in: ids } },
          select: { id: true, weightGrams: true, lengthCm: true, widthCm: true, heightCm: true, storeId: true, store: { select: { location: true } } },
        })
      : [];
    const productById = new Map(products.map((p) => [p.id, p]));
    for (const item of items) {
      const productId = String(item?.productId ?? '');
      const quantity = Math.min(20, Math.max(1, Math.floor(Number(item?.quantity) || 1)));
      if (!productId) continue;
      const product = productById.get(productId);
      if (!product) continue;
      const leg = legs.get(product.storeId) ?? { location: product.store.location, parcels: [] };
      for (let i = 0; i < quantity; i++) {
        leg.parcels.push({
          weightKg: Math.max(0.1, product.weightGrams / 1000),
          lengthCm: product.lengthCm,
          widthCm: product.widthCm,
          heightCm: product.heightCm,
        });
      }
      legs.set(product.storeId, leg);
    }

    const toOption = (r: RateQuote, priceCents = Math.round(r.price * 100)) => ({
      code: r.code,
      label: r.label,
      eta: r.eta,
      priceCents,
      provider: r.provider,
    });

    if (legs.size === 0) {
      const rates = await getShippingRates({
        sellerLocation,
        buyerAddress: address,
        weightKg: Math.max(0.1, (Number(body.weightGrams) || 1000) / 1000),
        buyerLat: latitude,
        buyerLng: longitude,
      });
      return Response.json({ options: rates.map((r) => toOption(r)), sellerCount: 1 });
    }

    const quotes = await Promise.all(
      [...legs.values()].map((leg) =>
        getShippingRates({
          sellerLocation: leg.location,
          buyerAddress: address,
          buyerLat: latitude,
          buyerLng: longitude,
          parcels: leg.parcels.slice(0, 20),
        }),
      ),
    );
    // Each option's price is what checkout will charge for it: per store,
    // the same service when that store has it, otherwise that store's
    // cheapest (checkout's own rule), rounded per order, then added up.
    const options = quotes[0].map((first) =>
      toOption(
        first,
        quotes.reduce((sum, storeQuotes) => {
          const match = storeQuotes.find((q) => q.code === first.code) ?? storeQuotes[0];
          return sum + (match ? Math.round(match.price * 100) : 0);
        }, 0),
      ),
    );
    return Response.json({ options, sellerCount: legs.size });
  } catch (e) {
    console.error('shipping quote error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not calculate delivery. Please try again.' }, { status: 500 });
  }
}
