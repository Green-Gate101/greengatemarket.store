// Seeds a THROWAWAY database for the device lab (CI only — never production).
// Usage: node qa-lab/seed.mjs <storeDir>   (DATABASE_URL + NEXTAUTH_SECRET in env)
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const storeDir = process.argv[2];
const require = createRequire(`${storeDir}/package.json`);
const { PrismaClient } = require('@prisma/client');
const sharp = require('sharp');
const { hashPassword } = await import(pathToFileURL(`${storeDir}/src/lib/password.ts`).href);
const { encryptSecret } = await import(pathToFileURL(`${storeDir}/src/lib/secret-box.ts`).href);

const db = new PrismaClient();

async function photo(r, g, b) {
  const object = await sharp({ create: { width: 360, height: 360, channels: 3, background: { r, g, b } } }).png().toBuffer();
  const jpg = await sharp({ create: { width: 800, height: 800, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: object, left: 220, top: 220 }]).jpeg({ quality: 82 }).toBuffer();
  return `data:image/jpeg;base64,${jpg.toString('base64')}`;
}

const buyer = await db.user.upsert({ where: { email: 'qa-buyer@example.test' }, update: {}, create: { email: 'qa-buyer@example.test', name: 'Thandi Nkosi', role: 'BUYER', emailVerified: new Date(), passwordHash: hashPassword('BuyerPass123') } });
const seller = await db.user.upsert({ where: { email: 'qa-seller@example.test' }, update: {}, create: { email: 'qa-seller@example.test', name: 'Sipho Dlamini', role: 'SELLER', emailVerified: new Date(), passwordHash: hashPassword('SellerPass123') } });
const store = await db.store.upsert({
  where: { userId: seller.id }, update: {},
  create: {
    userId: seller.id, slug: 'qa-kitchen-store-a1b2c3', name: "Mama's Kitchen & Home", description: 'Real kitchenware, delivered nationwide.', location: 'Durban, KwaZulu-Natal', phone: '0821234567', status: 'active',
    logoData: await photo(22, 163, 74), payoutProvider: 'payfast',
    payfastMerchantId: '10000100', payfastMerchantKeyEnc: encryptSecret('46f0cd694581a'), payfastPassphraseEnc: encryptSecret('Seller Pass 9'),
    bankName: 'FNB', bankAccountHolder: 'Mamas Kitchen Pty', bankAccountNumber: '62000000000', bankBranchCode: '250655', bankAccountType: 'cheque',
    businessType: 'pty', city: 'Durban', province: 'KwaZulu-Natal', postalCode: '4001', streetAddress: '12 Long Street', dispatchDays: 2, returnsDays: 14,
    confirmAge: true, confirmAccuracy: true, confirmTerms: true, applicationAt: new Date(),
  },
});
const cat = await db.category.findFirst({ where: { slug: 'home-living' } }) ?? await db.category.findFirst();
const products = [
  { slug: 'qa-steel-kettle-1a2b3c4d', name: 'Stainless Steel Kettle 1.7L', price: 49900, sale: 39900, stock: 12, rgb: [180, 180, 190] },
  { slug: 'qa-cast-iron-pot-5e6f7a8b', name: 'Cast Iron Potjie Pot No. 3', price: 89900, sale: null, stock: 5, rgb: [40, 40, 40] },
  { slug: 'qa-bamboo-board-9c0d1e2f', name: 'Bamboo Chopping Board (Large)', price: 24900, sale: null, stock: 30, rgb: [200, 160, 90] },
  { slug: 'qa-enamel-mug-3a4b5c6d', name: 'Enamel Camping Mug — Green', price: 12900, sale: 9900, stock: 0, rgb: [22, 140, 70] },
];
for (const p of products) {
  const prod = await db.product.upsert({
    where: { slug: p.slug }, update: { stock: p.stock, status: 'approved' },
    create: { storeId: store.id, categoryId: cat?.id ?? null, slug: p.slug, name: p.name, description: `${p.name} — sturdy, well made and delivered by courier anywhere in South Africa.`, brand: 'HomeCraft', status: 'approved', priceCents: p.price, salePriceCents: p.sale, stock: p.stock },
  });
  if (!(await db.productImage.findFirst({ where: { productId: prod.id } }))) {
    await db.productImage.create({ data: { productId: prod.id, dataUrl: await photo(...p.rgb), position: 0 } });
  }
}
// One product with size variants.
const tee = await db.product.upsert({
  where: { slug: 'qa-cotton-apron-7e8f9a0b' }, update: {},
  create: { storeId: store.id, categoryId: cat?.id ?? null, slug: 'qa-cotton-apron-7e8f9a0b', name: 'Cotton Kitchen Apron', description: 'Heavy cotton apron with two pockets, available in two sizes.', brand: 'HomeCraft', status: 'approved', priceCents: 19900, stock: 0 },
});
if (!(await db.productVariant.findFirst({ where: { productId: tee.id } }))) {
  await db.productVariant.createMany({ data: [
    { productId: tee.id, sku: 'QA-APRON-M', attributes: JSON.stringify({ Size: 'M' }), stock: 4, priceCents: null },
    { productId: tee.id, sku: 'QA-APRON-L', attributes: JSON.stringify({ Size: 'L' }), stock: 2, priceCents: 21900 },
  ] });
  await db.productImage.create({ data: { productId: tee.id, dataUrl: await photo(120, 60, 30), position: 0 } });
}
console.log(JSON.stringify({ buyer: buyer.email, seller: seller.email, store: store.slug, products: products.length + 1 }));
await db.$disconnect();
