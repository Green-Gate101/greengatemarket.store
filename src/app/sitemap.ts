import type { MetadataRoute } from "next";
import { sellingStoreWhere } from "@/lib/subscription";
import { db } from "@/lib/db";

// Homepage + every crawlable landing page: /store/<slug> for ACTIVE stores
// and /product/<slug> for APPROVED products of active stores (the same
// visibility rule as the catalogue — see src/lib/seo.ts). One sitemap holds
// at most 50,000 URLs (the protocol limit), newest listings first; past that
// size, split it with generateSitemaps + a sitemap index. This route must
// never throw: a failed database read simply returns the homepage entry.
export const dynamic = "force-dynamic";

const MAX_URLS = 50_000;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (process.env.NEXTAUTH_URL ?? "https://greengatemarket.store").replace(/\/+$/, "");
  let stores: { slug: string; createdAt: Date }[] = [];
  let products: { slug: string; updatedAt: Date }[] = [];
  try {
    stores = await db.store.findMany({
      where: sellingStoreWhere(),
      orderBy: { createdAt: "desc" },
      take: 5_000,
      select: { slug: true, createdAt: true },
    });
    products = await db.product.findMany({
      where: { status: "approved", store: sellingStoreWhere() },
      orderBy: { createdAt: "desc" },
      take: MAX_URLS - 1 - stores.length,
      select: { slug: true, updatedAt: true },
    });
  } catch {
    // Database not reachable — the sitemap remains valid with the homepage.
  }
  const newest = products[0]?.updatedAt;
  return [
    {
      url: `${base}/`,
      ...(newest ? { lastModified: newest } : {}),
      changeFrequency: "daily",
      priority: 1,
    },
    ...stores.map((s) => ({
      url: `${base}/store/${s.slug}`,
      lastModified: s.createdAt,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
    ...products.map((p) => ({
      url: `${base}/product/${p.slug}`,
      lastModified: p.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  ];
}
