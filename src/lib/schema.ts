import { db } from './db';

/**
 * Creates the SQLite schema on demand. On ephemeral hosts (Vercel serverless)
 * the database file starts empty, so the DDL runs once per cold start before
 * any seeding or querying happens. Idempotent and safe to call always.
 */
let schemaPromise: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = runDDL().catch((e) => {
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}

async function runDDL(): Promise<void> {
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Seller" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "storeName" TEXT NOT NULL,
      "ownerName" TEXT NOT NULL,
      "email" TEXT NOT NULL,
      "phone" TEXT NOT NULL,
      "location" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "Seller_email_key" ON "Seller"("email");
  `);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Product" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "sellerId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL,
      "category" TEXT NOT NULL,
      "price" REAL NOT NULL,
      "stock" INTEGER NOT NULL,
      "imageData" TEXT NOT NULL,
      "searchName" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Product_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "Product_sellerId_idx" ON "Product"("sellerId");
    CREATE INDEX IF NOT EXISTS "Product_category_idx" ON "Product"("category");
  `);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Order" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "sellerId" TEXT NOT NULL,
      "buyerName" TEXT NOT NULL,
      "buyerEmail" TEXT NOT NULL,
      "buyerPhone" TEXT NOT NULL,
      "address" TEXT NOT NULL,
      "shippingMethod" TEXT NOT NULL,
      "shippingCost" REAL NOT NULL,
      "subtotal" REAL NOT NULL,
      "total" REAL NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'paid',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Order_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "Order_sellerId_idx" ON "Order"("sellerId");
    CREATE INDEX IF NOT EXISTS "Order_createdAt_idx" ON "Order"("createdAt");
  `);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "OrderItem" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "orderId" TEXT NOT NULL,
      "productId" TEXT NOT NULL,
      "quantity" INTEGER NOT NULL,
      "unitPrice" REAL NOT NULL,
      CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "OrderItem_orderId_idx" ON "OrderItem"("orderId");
  `);
}
