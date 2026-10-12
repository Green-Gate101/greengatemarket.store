import type { MetadataRoute } from "next";
import { db } from "@/lib/db";

// The storefront is a single-page, hash-routed application, so the set of
// distinct crawlable URLs is the homepage. The newest approved product's
// updatedAt is used as a real freshness signal. This route must never throw:
// a failed database read (e.g. during a cold build) simply omits lastModified.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (process.env.NEXTAUTH_URL ?? "https://greengatemarket.store").replace(/\/+$/, "");
  let lastModified: Date | undefined;
  try {
    const newest = await db.product.findFirst({
      where: { status: "approved" },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    });
    if (newest) lastModified = newest.updatedAt;
  } catch {
    // Database not reachable — the sitemap remains valid without lastModified.
  }
  return [
    {
      url: `${base}/`,
      ...(lastModified ? { lastModified } : {}),
      changeFrequency: "daily",
      priority: 1,
    },
  ];
}
