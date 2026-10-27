import { db, IS_POSTGRES } from '@/lib/db';

/**
 * Runtime bootstrap for serverless hosts where the SQLite file is ephemeral
 * (Vercel /tmp): creates the schema, seeds the category taxonomy and ensures
 * the administrator account exists. Everything is idempotent.
 *
 * NOTE: on serverless hosts the SQLite file does not survive between
 * instances/cold starts. For durable multi-user production data point
 * DATABASE_URL at a hosted database and remove this runtime DDL path.
 */

let bootstrapPromise: Promise<void> | null = null;

/** Hosted Postgres gets its schema from `prisma db push` at build time
 *  (scripts/prepare-db.sh); the SQLite runtime DDL below would not apply.
 *  IS_POSTGRES is derived in db.ts from the actual runtime connection URL. */

export function bootstrap(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap().catch((e) => {
      bootstrapPromise = null;
      throw e;
    });
  }
  return bootstrapPromise;
}

const DDL = `
CREATE TABLE IF NOT EXISTS "User" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "email" TEXT NOT NULL,
  "emailVerified" DATETIME,
  "passwordHash" TEXT,
  "name" TEXT,
  "image" TEXT,
  "role" TEXT NOT NULL DEFAULT 'BUYER',
  "banned" BOOLEAN NOT NULL DEFAULT false,
  "phone" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");

CREATE TABLE IF NOT EXISTS "Account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerAccountId" TEXT NOT NULL,
  CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");
CREATE INDEX IF NOT EXISTS "Account_userId_idx" ON "Account"("userId");

CREATE TABLE IF NOT EXISTS "AuthToken" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "expires" DATETIME NOT NULL,
  "usedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "AuthToken_token_key" ON "AuthToken"("token");
CREATE INDEX IF NOT EXISTS "AuthToken_identifier_purpose_idx" ON "AuthToken"("identifier", "purpose");

CREATE TABLE IF NOT EXISTS "Category" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "parentId" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Category_slug_key" ON "Category"("slug");
CREATE INDEX IF NOT EXISTS "Category_parentId_idx" ON "Category"("parentId");

CREATE TABLE IF NOT EXISTS "Store" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "logoData" TEXT,
  "bannerData" TEXT,
  "location" TEXT NOT NULL DEFAULT '',
  "phone" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Store_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Store_userId_key" ON "Store"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "Store_slug_key" ON "Store"("slug");

CREATE TABLE IF NOT EXISTS "Product" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "storeId" TEXT NOT NULL,
  "categoryId" TEXT,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "brand" TEXT,
  "condition" TEXT NOT NULL DEFAULT 'new',
  "tags" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending_review',
  "moderationNote" TEXT,
  "priceCents" INTEGER NOT NULL,
  "salePriceCents" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'ZAR',
  "stock" INTEGER NOT NULL DEFAULT 0,
  "weightGrams" INTEGER NOT NULL DEFAULT 1000,
  "lengthCm" INTEGER NOT NULL DEFAULT 30,
  "widthCm" INTEGER NOT NULL DEFAULT 25,
  "heightCm" INTEGER NOT NULL DEFAULT 15,
  "viewCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Product_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Product_slug_key" ON "Product"("slug");
CREATE INDEX IF NOT EXISTS "Product_storeId_idx" ON "Product"("storeId");
CREATE INDEX IF NOT EXISTS "Product_status_idx" ON "Product"("status");
CREATE INDEX IF NOT EXISTS "Product_categoryId_idx" ON "Product"("categoryId");
CREATE INDEX IF NOT EXISTS "Product_createdAt_idx" ON "Product"("createdAt");
CREATE INDEX IF NOT EXISTS "Product_priceCents_idx" ON "Product"("priceCents");

CREATE TABLE IF NOT EXISTS "ProductImage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "productId" TEXT NOT NULL,
  "dataUrl" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ProductImage_productId_idx" ON "ProductImage"("productId");

CREATE TABLE IF NOT EXISTS "ProductVariant" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "productId" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "attributes" TEXT NOT NULL,
  "priceCents" INTEGER,
  "stock" INTEGER NOT NULL DEFAULT 0,
  "imageData" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProductVariant_sku_key" ON "ProductVariant"("sku");
CREATE INDEX IF NOT EXISTS "ProductVariant_productId_idx" ON "ProductVariant"("productId");

CREATE TABLE IF NOT EXISTS "CartItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "variantId" TEXT,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CartItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CartItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CartItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "CartItem_userId_productId_variantId_key" ON "CartItem"("userId", "productId", "variantId");
CREATE INDEX IF NOT EXISTS "CartItem_userId_idx" ON "CartItem"("userId");

CREATE TABLE IF NOT EXISTS "WishlistItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WishlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WishlistItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "WishlistItem_userId_productId_key" ON "WishlistItem"("userId", "productId");
CREATE INDEX IF NOT EXISTS "WishlistItem_userId_idx" ON "WishlistItem"("userId");

CREATE TABLE IF NOT EXISTS "Order" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "number" TEXT NOT NULL,
  "buyerId" TEXT,
  "buyerName" TEXT NOT NULL,
  "buyerEmail" TEXT NOT NULL,
  "buyerPhone" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "shippingMethod" TEXT NOT NULL,
  "shippingCents" INTEGER NOT NULL,
  "subtotalCents" INTEGER NOT NULL,
  "totalCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'ZAR',
  "status" TEXT NOT NULL DEFAULT 'pending_payment',
  "paymentProvider" TEXT NOT NULL DEFAULT 'bank_transfer',
  "paymentStatus" TEXT NOT NULL DEFAULT 'awaiting_payment',
  "paymentRef" TEXT,
  "idempotencyKey" TEXT,
  "deliveryLat" REAL,
  "deliveryLng" REAL,
  "deliveryAccuracyMeters" INTEGER,
  "deliveryPinSource" TEXT,
  "storeId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Order_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Order_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Order_number_key" ON "Order"("number");
CREATE UNIQUE INDEX IF NOT EXISTS "Order_idempotencyKey_key" ON "Order"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "Order_buyerId_idx" ON "Order"("buyerId");
CREATE INDEX IF NOT EXISTS "Order_storeId_idx" ON "Order"("storeId");
CREATE INDEX IF NOT EXISTS "Order_createdAt_idx" ON "Order"("createdAt");
CREATE INDEX IF NOT EXISTS "Order_status_idx" ON "Order"("status");

CREATE TABLE IF NOT EXISTS "OrderItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "variantId" TEXT,
  "storeId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "variantLabel" TEXT,
  "quantity" INTEGER NOT NULL,
  "unitPriceCents" INTEGER NOT NULL,
  CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "OrderItem_orderId_idx" ON "OrderItem"("orderId");
CREATE INDEX IF NOT EXISTS "OrderItem_storeId_idx" ON "OrderItem"("storeId");

CREATE TABLE IF NOT EXISTS "OrderEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "note" TEXT,
  "actorId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OrderEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "OrderEvent_orderId_idx" ON "OrderEvent"("orderId");

CREATE TABLE IF NOT EXISTS "Review" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "productId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "rating" INTEGER NOT NULL,
  "title" TEXT,
  "body" TEXT NOT NULL,
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Review_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Review_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Review_productId_userId_key" ON "Review"("productId", "userId");
CREATE INDEX IF NOT EXISTS "Review_productId_idx" ON "Review"("productId");

CREATE TABLE IF NOT EXISTS "ProductEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "productId" TEXT NOT NULL,
  "userId" TEXT,
  "guestId" TEXT,
  "type" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductEvent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProductEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ProductEvent_productId_type_createdAt_idx" ON "ProductEvent"("productId", "type", "createdAt");
CREATE INDEX IF NOT EXISTS "ProductEvent_userId_createdAt_idx" ON "ProductEvent"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "ProductEvent_guestId_idx" ON "ProductEvent"("guestId");

CREATE TABLE IF NOT EXISTS "RecommendationState" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "scope" TEXT NOT NULL,
  "data" TEXT NOT NULL,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "RecommendationState_scope_key" ON "RecommendationState"("scope");
CREATE INDEX IF NOT EXISTS "RecommendationState_updatedAt_idx" ON "RecommendationState"("updatedAt");

CREATE TABLE IF NOT EXISTS "AuditLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actorId" TEXT,
  "actorEmail" TEXT,
  "action" TEXT NOT NULL,
  "target" TEXT,
  "detail" TEXT,
  "ip" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_action_idx" ON "AuditLog"("action");

CREATE TABLE IF NOT EXISTS "Notification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "link" TEXT,
  "readAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

CREATE TABLE IF NOT EXISTS "Address" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "label" TEXT NOT NULL DEFAULT 'Home',
  "recipientName" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "street" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "province" TEXT NOT NULL,
  "postalCode" TEXT NOT NULL,
  "latitude" REAL,
  "longitude" REAL,
  "accuracyMeters" INTEGER,
  "locationSource" TEXT NOT NULL DEFAULT 'manual',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Address_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Address_userId_isDefault_idx" ON "Address"("userId", "isDefault");
CREATE INDEX IF NOT EXISTS "Address_userId_createdAt_idx" ON "Address"("userId", "createdAt");
`;

/**
 * Additive migrations for databases created before the seller-application and
 * recommendation features. SQLite has no "ADD COLUMN IF NOT EXISTS", so each
 * statement is attempted individually and duplicate-column errors are ignored.
 */
const MIGRATIONS = [
  `ALTER TABLE "User" ADD COLUMN "banned" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "Product" ADD COLUMN "lengthCm" INTEGER NOT NULL DEFAULT 30`,
  `ALTER TABLE "Product" ADD COLUMN "widthCm" INTEGER NOT NULL DEFAULT 25`,
  `ALTER TABLE "Product" ADD COLUMN "heightCm" INTEGER NOT NULL DEFAULT 15`,
  `ALTER TABLE "Store" ADD COLUMN "businessName" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "businessType" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "registrationNumber" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "taxNumber" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "idNumber" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "streetAddress" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "city" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "province" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "postalCode" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "websiteOrSocial" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "bankName" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "bankAccountType" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "bankAccountNumber" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "bankBranchCode" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "bankAccountHolder" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "productCategories" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "sourcing" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "monthlyVolume" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "dispatchDays" INTEGER`,
  `ALTER TABLE "Store" ADD COLUMN "returnsDays" INTEGER`,
  `ALTER TABLE "Store" ADD COLUMN "ownsBrand" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "Store" ADD COLUMN "confirmAge" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "Store" ADD COLUMN "confirmAccuracy" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "Store" ADD COLUMN "confirmTerms" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "Store" ADD COLUMN "applicationAt" DATETIME`,
  `ALTER TABLE "ProductEvent" ADD COLUMN "guestId" TEXT`,
  `CREATE INDEX IF NOT EXISTS "ProductEvent_guestId_idx" ON "ProductEvent"("guestId")`,
  `CREATE INDEX IF NOT EXISTS "ProductEvent_userId_createdAt_idx" ON "ProductEvent"("userId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "ProductEvent_type_createdAt_idx" ON "ProductEvent"("type", "createdAt")`,
  // Order GPS pin columns — the exact delivery fix handed to The Courier Guy.
  `ALTER TABLE "Order" ADD COLUMN "deliveryLat" REAL`,
  `ALTER TABLE "Order" ADD COLUMN "deliveryLng" REAL`,
  `ALTER TABLE "Order" ADD COLUMN "deliveryAccuracyMeters" INTEGER`,
  `ALTER TABLE "Order" ADD COLUMN "deliveryPinSource" TEXT`,
  `ALTER TABLE "Address" ADD COLUMN "accuracyMeters" INTEGER`,
  // Seller subscriptions + admin ↔ seller messages.
  `ALTER TABLE "Store" ADD COLUMN "trialEndsAt" DATETIME`,
  `ALTER TABLE "Store" ADD COLUMN "paidUntil" DATETIME`,
  `ALTER TABLE "Store" ADD COLUMN "accessUntil" DATETIME`,
  `ALTER TABLE "Store" ADD COLUMN "subscriptionPlan" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "billingExempt" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "Store" ADD COLUMN "billingExemptNote" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "billingNotice" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "applicationSignature" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "verifiedAt" DATETIME`,
  `ALTER TABLE "Store" ADD COLUMN "verifiedNote" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "pickupPaxiCents" INTEGER`,
  `ALTER TABLE "Store" ADD COLUMN "pickupPaxiEta" TEXT`,
  `ALTER TABLE "Store" ADD COLUMN "pickupPudoCents" INTEGER`,
  `ALTER TABLE "Store" ADD COLUMN "pickupPudoEta" TEXT`,
  `ALTER TABLE "Order" ADD COLUMN "discountCodeId" TEXT`,
  `ALTER TABLE "Order" ADD COLUMN "discountCode" TEXT`,
  `ALTER TABLE "Order" ADD COLUMN "discountCents" INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS "DiscountCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "percentOff" INTEGER,
    "amountOffCents" INTEGER,
    "minSubtotalCents" INTEGER NOT NULL DEFAULT 0,
    "firstOrderOnly" BOOLEAN NOT NULL DEFAULT false,
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" DATETIME,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "disabledByAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DiscountCode_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "DiscountCode_storeId_code_key" ON "DiscountCode"("storeId", "code")`,
  `CREATE INDEX IF NOT EXISTS "DiscountCode_code_idx" ON "DiscountCode"("code")`,
  `CREATE INDEX IF NOT EXISTS "Store_status_accessUntil_idx" ON "Store"("status", "accessUntil")`,
  `CREATE TABLE IF NOT EXISTS "SubscriptionPayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reference" TEXT NOT NULL,
    "yocoCheckoutId" TEXT,
    "periodStart" DATETIME,
    "periodEnd" DATETIME,
    "paidAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SubscriptionPayment_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SubscriptionPayment_reference_key" ON "SubscriptionPayment"("reference")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SubscriptionPayment_yocoCheckoutId_key" ON "SubscriptionPayment"("yocoCheckoutId")`,
  `CREATE INDEX IF NOT EXISTS "SubscriptionPayment_storeId_createdAt_idx" ON "SubscriptionPayment"("storeId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "SubscriptionPayment_status_createdAt_idx" ON "SubscriptionPayment"("status", "createdAt")`,
  `CREATE TABLE IF NOT EXISTS "SellerMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "fromAdmin" BOOLEAN NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SellerMessage_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS "SellerMessage_storeId_createdAt_idx" ON "SellerMessage"("storeId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "SellerMessage_fromAdmin_readAt_idx" ON "SellerMessage"("fromAdmin", "readAt")`,
];

async function runMigrations(): Promise<void> {
  for (const statement of MIGRATIONS) {
    try {
      await db.$executeRawUnsafe(statement);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!/duplicate column|already exists/i.test(message)) {
        throw e;
      }
    }
  }
}

/** Marketplace taxonomy: database-driven so admins can extend without code changes. */
const TAXONOMY: { slug: string; name: string; sortOrder: number; children?: { slug: string; name: string }[] }[] = [
  { slug: 'women', name: 'Women', sortOrder: 1, children: [
    { slug: 'women-dresses', name: 'Dresses' }, { slug: 'women-tops', name: 'Tops' },
    { slug: 'women-bottoms', name: 'Bottoms' }, { slug: 'women-jeans', name: 'Jeans' },
    { slug: 'women-skirts', name: 'Skirts' }, { slug: 'women-jackets', name: 'Jackets' },
    { slug: 'women-activewear', name: 'Activewear' }, { slug: 'women-beachwear', name: 'Beachwear' },
  ] },
  { slug: 'men', name: 'Men', sortOrder: 2, children: [
    { slug: 'men-tshirts', name: 'T-Shirts' }, { slug: 'men-shirts', name: 'Shirts' },
    { slug: 'men-hoodies', name: 'Hoodies' }, { slug: 'men-jeans', name: 'Jeans' },
    { slug: 'men-trousers', name: 'Trousers' }, { slug: 'men-suits', name: 'Suits' },
    { slug: 'men-activewear', name: 'Activewear' },
  ] },
  { slug: 'kids', name: 'Kids', sortOrder: 3 },
  { slug: 'shoes', name: 'Shoes', sortOrder: 4, children: [
    { slug: 'shoes-sneakers', name: 'Sneakers' }, { slug: 'shoes-heels', name: 'Heels' },
    { slug: 'shoes-boots', name: 'Boots' }, { slug: 'shoes-sandals', name: 'Sandals' },
    { slug: 'shoes-formal', name: 'Formal Shoes' }, { slug: 'shoes-sports', name: 'Sports Shoes' },
  ] },
  { slug: 'accessories', name: 'Jewelry & Accessories', sortOrder: 5, children: [
    { slug: 'jewelry', name: 'Jewelry' }, { slug: 'watches', name: 'Watches' },
    { slug: 'sunglasses', name: 'Sunglasses' }, { slug: 'belts', name: 'Belts' },
    { slug: 'hats', name: 'Hats' },
  ] },
  { slug: 'beauty', name: 'Beauty & Health', sortOrder: 6, children: [
    { slug: 'skincare', name: 'Skincare' }, { slug: 'haircare', name: 'Haircare' },
    { slug: 'personal-care', name: 'Personal Care' }, { slug: 'wellness', name: 'Wellness' },
  ] },
  { slug: 'home-living', name: 'Home & Living', sortOrder: 7, children: [
    { slug: 'decor', name: 'Décor' }, { slug: 'kitchen', name: 'Kitchen' },
    { slug: 'storage', name: 'Storage' }, { slug: 'lighting', name: 'Lighting' },
  ] },
  { slug: 'bags-luggage', name: 'Bags & Luggage', sortOrder: 8, children: [
    { slug: 'handbags', name: 'Handbags' }, { slug: 'backpacks', name: 'Backpacks' },
    { slug: 'wallets', name: 'Wallets' }, { slug: 'luggage', name: 'Luggage' },
  ] },
  { slug: 'sports', name: 'Sports & Outdoors', sortOrder: 9, children: [
    { slug: 'fitness', name: 'Fitness' }, { slug: 'running', name: 'Running' },
    { slug: 'outdoor', name: 'Outdoor' },
  ] },
  { slug: 'underwear-sleepwear', name: 'Underwear & Sleepwear', sortOrder: 10 },
  { slug: 'home-textiles', name: 'Home Textiles', sortOrder: 11, children: [
    { slug: 'bedding', name: 'Bedding' }, { slug: 'towels', name: 'Towels' },
    { slug: 'curtains', name: 'Curtains' },
  ] },
  { slug: 'baby-maternity', name: 'Baby & Maternity', sortOrder: 12 },
  { slug: 'toys-games', name: 'Toys & Games', sortOrder: 13 },
  { slug: 'office-school', name: 'Office & School Supplies', sortOrder: 14 },
  { slug: 'pet-supplies', name: 'Pet Supplies', sortOrder: 15 },
];

async function runBootstrap(): Promise<void> {
  // 1. Schema (idempotent; SQLite only — hosted Postgres is pushed at build)
  if (!IS_POSTGRES) {
    const statements = DDL.split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await db.$executeRawUnsafe(statement);
    }
    await runMigrations();
  }

  // 2. Category taxonomy
  for (const cat of TAXONOMY) {
    const parent = await db.category.upsert({
      where: { slug: cat.slug },
      update: { name: cat.name, sortOrder: cat.sortOrder },
      create: { slug: cat.slug, name: cat.name, sortOrder: cat.sortOrder },
    });
    for (const [i, child] of (cat.children ?? []).entries()) {
      await db.category.upsert({
        where: { slug: child.slug },
        update: { name: child.name, parentId: parent.id, sortOrder: i + 1 },
        create: { slug: child.slug, name: child.name, parentId: parent.id, sortOrder: i + 1 },
      });
    }
  }

  // 3. Administrator account (credentials come from environment; no defaults)
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const { hashPassword } = await import('./password');
    const existing = await db.user.findUnique({ where: { email: adminEmail } });
    if (!existing) {
      await db.user.create({
        data: {
          email: adminEmail,
          name: 'Green Gate Admin',
          role: 'ADMIN',
          emailVerified: new Date(),
          passwordHash: hashPassword(adminPassword),
        },
      });
      console.log('[bootstrap] administrator account provisioned');
    } else if (!existing.passwordHash) {
      // The administrator account exists without a password (e.g. created
      // through Google): give it the environment password once.
      await db.user.update({ where: { id: existing.id }, data: { passwordHash: hashPassword(adminPassword) } });
      console.log('[bootstrap] administrator password set from environment');
    }
    // An existing administrator password is NEVER overwritten from the
    // environment: it used to be re-synced on every cold start, which silently
    // undid "Forgot password" resets within minutes — so a leaked password
    // could not be locked out by resetting it. ADMIN_PASSWORD now only seeds
    // the first password; change it afterwards with the reset flow.
  }

  // 4. Seller subscriptions (idempotent): every store that was already selling
  //    before subscriptions existed gets its one-time 30-day free trial from
  //    now, and stores owned by the administrator are free. New stores start
  //    their trial when they are approved (admin store_status action).
  try {
    const { trialStartData } = await import('./subscription');
    await db.store.updateMany({
      where: { status: 'active', billingExempt: false, trialEndsAt: null, accessUntil: null },
      data: trialStartData(),
    });
    await db.store.updateMany({
      where: { billingExempt: false, user: { role: 'ADMIN' } },
      data: { billingExempt: true, billingExemptNote: 'Administrator account' },
    });
  } catch (e) {
    console.error('[bootstrap] subscription backfill failed:', e instanceof Error ? e.message : e);
  }
}
