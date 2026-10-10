/**
 * Builds src/lib/seed-products.ts from the raw generated product photos in
 * seed-images/. Every image passes through the same automatic white-background
 * pipeline used for real seller uploads, so the storefront dataset looks
 * exactly like production data.
 *
 * Run: bun run scripts/generate-seed-assets.ts
 */
import fs from 'fs';
import path from 'path';
import { processProductImage } from '../src/lib/image-processing';

interface SeedProduct {
  key: string;
  sellerKey: string;
  name: string;
  description: string;
  category: string;
  price: number;
  stock: number;
}

const defs: SeedProduct[] = [
  { key: 'beaded-bracelet', sellerKey: 'kasi-krafts', name: 'Isiboho Beaded Bracelet', description: 'Hand-beaded bracelet with a bold geometric pattern, woven by artisans in Soweto. Elasticated fit, water-resistant beads, one size.', category: 'Fashion & Accessories', price: 189.99, stock: 42 },
  { key: 'wooden-bowl', sellerKey: 'kasi-krafts', name: 'Hand-Carved Wooden Serving Bowl', description: 'Turned from sustainably harvested jacaranda wood and finished with food-safe oil. Each bowl carries its own grain story. 28cm diameter.', category: 'Home & Living', price: 649.0, stock: 18 },
  { key: 'canvas-tote', sellerKey: 'kasi-krafts', name: 'Everyday Canvas Tote', description: 'Heavyweight 16oz natural canvas tote with full-grain leather straps and an inner zip pocket. Carries laptops up to 15 inches.', category: 'Fashion & Accessories', price: 429.5, stock: 30 },
  { key: 'leather-laptop-sleeve', sellerKey: 'kasi-krafts', name: 'Leather Laptop Sleeve 14"', description: 'Vegetable-tanned full-grain leather sleeve with wool felt lining and a magnetic fold-over closure. Ages beautifully with use.', category: 'Fashion & Accessories', price: 899.0, stock: 14 },
  { key: 'rooibos-tea-tin', sellerKey: 'cape-bean', name: 'Premium Rooibos Tea Tin', description: 'Single-origin Cederberg rooibos, naturally caffeine-free, packed in a keepsake tin. 80g of hand-pressed loose leaf — about 40 cups.', category: 'Food & Drink', price: 159.99, stock: 65 },
  { key: 'honey-jar', sellerKey: 'cape-bean', name: 'Raw Fynbos Honey 500g', description: 'Unfiltered, unpasteurised fynbos honey from hives on the Cape Peninsula. Floral, complex and crystallises naturally. 500g glass jar with wooden dipper.', category: 'Food & Drink', price: 235.0, stock: 27 },
  { key: 'espresso-mug-set', sellerKey: 'cape-bean', name: 'Stoneware Espresso Mug Set', description: 'Set of two hand-thrown stoneware espresso mugs in cream and terracotta with a reactive glaze. Dishwasher and microwave safe. 90ml each.', category: 'Home & Living', price: 349.99, stock: 22 },
  { key: 'baobab-oil', sellerKey: 'baobab-beauty', name: 'Cold-Pressed Baobab Facial Oil', description: 'Cold-pressed baobab oil rich in omega 3, 6 and 9 fatty acids. Absorbs quickly, non-comedogenic, suitable for all skin types. 30ml amber dropper bottle.', category: 'Beauty & Wellness', price: 399.0, stock: 38 },
  { key: 'soy-candle', sellerKey: 'baobab-beauty', name: 'African Sunset Soy Candle', description: 'Hand-poured soy wax candle with notes of marula, amber and dried orange peel. 45-hour burn time in a reusable amber glass jar.', category: 'Home & Living', price: 285.0, stock: 45 },
  { key: 'trail-backpack', sellerKey: 'trailhead', name: 'Kloofing Trail Pack 18L', description: 'Ripstop nylon trail running pack with a 2L hydration bladder sleeve, four front pockets and a bounce-free harness. 18 litres, 480g.', category: 'Sports & Outdoors', price: 1249.0, stock: 12 },
  { key: 'steel-bottle', sellerKey: 'trailhead', name: 'Insulated Steel Bottle 750ml', description: 'Double-walled 18/8 stainless steel bottle keeps drinks cold for 24 hours or hot for 12. Matte powder-coated finish, leak-proof cap.', category: 'Sports & Outdoors', price: 449.99, stock: 50 },
  { key: 'wireless-earbuds', sellerKey: 'trailhead', name: 'Drift Wireless Earbuds', description: 'Bluetooth 5.3 earbuds with ANC, 28-hour total battery life and an IPX5 sweat rating. USB-C fast charge gives 2 hours of playback in 10 minutes.', category: 'Electronics', price: 1099.0, stock: 25 },
];

const sellers: Record<string, { storeName: string; ownerName: string; email: string; phone: string; location: string }> = {
  'kasi-krafts': { storeName: 'Kasi Krafts', ownerName: 'Thabo Mokoena', email: 'thabo@kasikrafts.co.za', phone: '+27 82 551 0142', location: 'Soweto, Johannesburg' },
  'cape-bean': { storeName: 'Cape Bean & Brew', ownerName: 'Aisha van der Merwe', email: 'aisha@capebeanbrew.co.za', phone: '+27 83 220 8874', location: 'Woodstock, Cape Town' },
  'baobab-beauty': { storeName: 'Baobab Beauty Co.', ownerName: 'Naledi Dlamini', email: 'naledi@baobabbeauty.co.za', phone: '+27 84 903 2261', location: 'Umhlanga, Durban' },
  trailhead: { storeName: 'Trailhead Gear', ownerName: 'Sipho Ndlovu', email: 'sipho@trailheadgear.co.za', phone: '+27 81 447 5590', location: 'Stellenbosch, Western Cape' },
};

async function main() {
  const dir = path.join(process.cwd(), 'seed-images');
  const lines: string[] = [];
  lines.push('// Auto-generated from seed-images/ — do not edit by hand.');
  lines.push('// Images already processed through the white-background pipeline.');
  lines.push('export interface SeedProductAsset {');
  lines.push('  key: string;');
  lines.push('  sellerKey: string;');
  lines.push('  name: string;');
  lines.push('  description: string;');
  lines.push('  category: string;');
  lines.push('  price: number;');
  lines.push('  stock: number;');
  lines.push('  imageData: string;');
  lines.push('}');
  lines.push('');
  lines.push('export const SEED_SELLERS: Record<string, { storeName: string; ownerName: string; email: string; phone: string; location: string }> = ' + JSON.stringify(sellers, null, 2) + ';');
  lines.push('');
  lines.push('export const SEED_PRODUCT_ASSETS: SeedProductAsset[] = [');

  for (const def of defs) {
    const file = path.join(dir, `${def.key}.png`);
    if (!fs.existsSync(file)) {
      console.warn(`missing image for ${def.key} — skipping`);
      continue;
    }
    const processed = await processProductImage(fs.readFileSync(file));
    console.log(`processed ${def.key} (${(processed.buffer.length / 1024).toFixed(0)} KB)`);
    lines.push('  {');
    lines.push(`    key: ${JSON.stringify(def.key)},`);
    lines.push(`    sellerKey: ${JSON.stringify(def.sellerKey)},`);
    lines.push(`    name: ${JSON.stringify(def.name)},`);
    lines.push(`    description: ${JSON.stringify(def.description)},`);
    lines.push(`    category: ${JSON.stringify(def.category)},`);
    lines.push(`    price: ${def.price},`);
    lines.push(`    stock: ${def.stock},`);
    lines.push(`    imageData: ${JSON.stringify(processed.dataUrl)},`);
    lines.push('  },');
  }
  lines.push('];');
  lines.push('');

  fs.writeFileSync(path.join(process.cwd(), 'src/lib/seed-products.ts'), lines.join('\n'));
  console.log('wrote src/lib/seed-products.ts');
}

main();
