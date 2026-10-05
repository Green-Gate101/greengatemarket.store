import { db } from './db';
import { SEED_PRODUCT_ASSETS, SEED_SELLERS } from './seed-products';
import { indexProduct } from './algolia';

/** Deterministic PRNG so the demo dataset is stable between reseeds. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BUYERS = [
  'Lerato Khumalo', 'Johan Pretorius', 'Zanele Mthembu', 'Daniel Jacobs', 'Palesa Molefe',
  'Kyle Botha', 'Nomvula Sithole', 'Riaan du Plessis', 'Ayanda Ngcobo', 'Megan Williams',
  'Karabo Motsepe', 'Chantelle Fourie', 'Bongani Zulu', 'Tarryn Naidoo', 'Sibusiso Mahlangu',
  'Emma van Wyk', 'Thulani Hadebe', 'Nadia Patel', 'Andile Mbatha', 'Christo Steyn',
  'Refilwe Tau', 'Jason Petersen', 'Mbali Khoza', 'Pieter Grobler',
];

const ADDRESSES = [
  '12 Melville Road, Auckland Park, Johannesburg, 2092',
  '88 Long Street, Cape Town City Centre, Cape Town, 8001',
  '5 Florida Road, Morningside, Durban, 4001',
  '236 Church Street, Stellenbosch Central, Stellenbosch, 7600',
  '41 Jan Hofmeyr Road, Westdene, Bloemfontein, 9301',
  '73 Ring Road, Greenacres, Gqeberha, 6045',
  '9 Rivonia Boulevard, Rivonia, Sandton, 2128',
  '156 Kate Street, Bryantdirp, Pretoria, 0181',
];

const SHIPPING = ['economy', 'standard', 'express'];
const STATUSES = ['paid', 'packed', 'shipped', 'delivered'];

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

/**
 * Inserts the demo marketplace dataset. Idempotent: it only runs when the
 * database has no sellers yet, which also makes it safe on ephemeral
 * serverless hosts — a cold start simply reseeds.
 */
export async function seedNow(): Promise<{ seeded: boolean }> {
  const existing = await db.seller.count();
  if (existing > 0) return { seeded: false };

  const sellerIds = new Map<string, string>();
  for (const [key, s] of Object.entries(SEED_SELLERS)) {
    const created = await db.seller.create({ data: s });
    sellerIds.set(key, created.id);
  }

  const productsBySeller = new Map<string, Array<{ id: string; price: number }>>();
  for (const asset of SEED_PRODUCT_ASSETS) {
    const sellerId = sellerIds.get(asset.sellerKey);
    if (!sellerId) continue;
    const created = await db.product.create({
      data: {
        sellerId,
        name: asset.name,
        description: asset.description,
        category: asset.category,
        price: asset.price,
        stock: asset.stock,
        imageData: asset.imageData,
        searchName: `${asset.name} ${asset.description} ${asset.category}`.toLowerCase(),
      },
    });
    const list = productsBySeller.get(asset.sellerKey) ?? [];
    list.push({ id: created.id, price: asset.price });
    productsBySeller.set(asset.sellerKey, list);
  }

  // Two weeks of believable order history with a gentle upward trend.
  const rand = mulberry32(20250419);
  const shippingCosts: Record<string, number> = { economy: 45, standard: 75, express: 130 };
  const now = new Date();

  for (let dayOffset = 13; dayOffset >= 0; dayOffset--) {
    const trend = 1 + (13 - dayOffset) * 0.055;
    const weekend = [0, 6].includes(now.getDay()) ? 0.8 : 1.1;
    const count = Math.max(1, Math.round(rand() * 2.2 + 2.5 * trend * weekend));

    for (let i = 0; i < count; i++) {
      const sellerKey = pick(rand, [...productsBySeller.keys()]);
      const sellerProducts = productsBySeller.get(sellerKey) ?? [];
      if (sellerProducts.length === 0) continue;
      const itemDefs = rand() < 0.75 ? [pick(rand, sellerProducts)] : [
        pick(rand, sellerProducts),
        pick(rand, sellerProducts),
      ].filter((v, idx, arr) => arr.findIndex((x) => x.id === v.id) === idx);

      const items = itemDefs.map((p) => ({ productId: p.id, unitPrice: p.price, quantity: 1 + Math.floor(rand() * 3) }));
      const subtotal = items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);
      const method = pick(rand, SHIPPING);
      const shippingCost = shippingCosts[method] ?? 75;

      const createdAt = new Date(now);
      createdAt.setDate(createdAt.getDate() - dayOffset);
      createdAt.setHours(8 + Math.floor(rand() * 11), Math.floor(rand() * 60), Math.floor(rand() * 60), 0);
      if (createdAt > now) createdAt.setTime(now.getTime());

      const status = dayOffset > 6 ? 'delivered' : pick(rand, STATUSES);

      await db.order.create({
        data: {
          sellerId: sellerIds.get(sellerKey)!,
          buyerName: pick(rand, BUYERS),
          buyerEmail: 'buyer@example.com',
          buyerPhone: '+27 7' + Math.floor(10000000 + rand() * 89999999),
          address: pick(rand, ADDRESSES),
          shippingMethod: method,
          shippingCost,
          subtotal: Math.round(subtotal * 100) / 100,
          total: Math.round((subtotal + shippingCost) * 100) / 100,
          status,
          createdAt,
          items: { create: items },
        },
      });
    }
  }

  // Keep Algolia in sync with the seeded catalogue (best effort).
  const allProducts = await db.product.findMany({ include: { seller: { select: { storeName: true } } } });
  await Promise.all(
    allProducts.map((p) =>
      indexProduct({
        objectID: p.id,
        name: p.name,
        description: p.description,
        category: p.category,
        price: p.price,
        sellerName: p.seller.storeName,
      }),
    ),
  );

  return { seeded: true };
}

let seedPromise: Promise<{ seeded: boolean }> | null = null;

/** Ensure the marketplace has data before serving reads. */
export function ensureSeed(): Promise<{ seeded: boolean }> {
  if (!seedPromise) {
    seedPromise = seedNow().catch((e) => {
      seedPromise = null;
      throw e;
    });
  }
  return seedPromise;
}
