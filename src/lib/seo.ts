import { cache } from 'react';
import { db } from '@/lib/db';

/**
 * Crawlable landing pages (additive): /product/<slug> and /store/<slug> are
 * real server-rendered URLs with Open Graph tags + schema.org JSON-LD, so
 * search engines index listings and WhatsApp/Facebook/X show rich link
 * previews. The SPA keeps rendering every screen from the hash exactly as
 * before — these pages only add a crawlable entry point per listing.
 *
 * Visibility rules are the catalogue's: only APPROVED products of ACTIVE
 * stores, and only ACTIVE stores, are ever exposed.
 */

export function siteUrl(): string {
  return (process.env.NEXTAUTH_URL ?? 'https://greengatemarket.store').replace(/\/+$/, '');
}

/** Absolute URL of a product photo as a real image file (preview bots
 *  cannot read the base64 data URLs the API ships). */
export function productImageUrl(imageId: string): string {
  return `${siteUrl()}/api/images/${encodeURIComponent(imageId)}`;
}

export function storeLogoUrl(storeId: string): string {
  return `${siteUrl()}/api/images/store/${encodeURIComponent(storeId)}`;
}

/** Plain-text snippet for meta descriptions (whitespace collapsed, cut on a word). */
export function plainSnippet(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).trimEnd()}…`;
}

/** JSON-LD for a <script> tag: seller-typed text can never close the tag. */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** One query per request, shared by generateMetadata and the page. */
export const loadPublicProduct = cache(async (slug: string) => {
  const product = await db.product.findUnique({
    where: { slug },
    select: {
      id: true, slug: true, name: true, description: true, brand: true, condition: true,
      priceCents: true, salePriceCents: true, currency: true, stock: true, status: true, updatedAt: true,
      store: { select: { id: true, slug: true, name: true, location: true, status: true } },
      category: { select: { slug: true, name: true } },
      images: { orderBy: { position: 'asc' }, take: 4, select: { id: true } },
      variants: { where: { active: true }, orderBy: { sku: 'asc' }, select: { sku: true, stock: true, priceCents: true } },
    },
  });
  if (!product || product.status !== 'approved' || product.store.status !== 'active') return null;
  const agg = await db.review.aggregate({ where: { productId: product.id }, _avg: { rating: true }, _count: { rating: true } });
  return { ...product, ratingAvg: agg._avg.rating ?? 0, ratingCount: agg._count.rating };
});

export const loadPublicStore = cache(async (slug: string) => {
  const store = await db.store.findUnique({
    where: { slug },
    select: {
      id: true, slug: true, name: true, description: true, location: true, status: true, createdAt: true,
      ratingSum: true, ratingCount: true,
      // Presence only — the base64 logo itself is served by /api/images/store/<id>.
      logoData: true,
    },
  });
  if (!store || store.status !== 'active') return null;
  const products = await db.product.findMany({
    where: { storeId: store.id, status: 'approved' },
    orderBy: { createdAt: 'desc' },
    take: 48,
    select: { slug: true, name: true, priceCents: true, salePriceCents: true, currency: true, images: { orderBy: { position: 'asc' }, take: 1, select: { id: true } } },
  });
  const { logoData, ...rest } = store;
  return { ...rest, hasLogo: Boolean(logoData), products };
});

const CONDITION_SCHEMA: Record<string, string> = {
  new: 'https://schema.org/NewCondition',
  refurbished: 'https://schema.org/RefurbishedCondition',
  pre_loved: 'https://schema.org/UsedCondition',
};

export function conditionSchema(condition: string): string {
  return CONDITION_SCHEMA[condition] ?? CONDITION_SCHEMA.new;
}
