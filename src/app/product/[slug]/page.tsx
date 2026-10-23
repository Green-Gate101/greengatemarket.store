import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GateMark } from '@/components/greengate/brand';
import { SpaLanding } from '@/components/greengate/spa-landing';
import { formatMoney } from '@/lib/types';
import { conditionSchema, jsonLdScript, loadPublicProduct, plainSnippet, productImageUrl, siteUrl } from '@/lib/seo';

/**
 * Crawlable product page — /product/<slug> (see src/lib/seo.ts). Edge-cached
 * for 5 minutes (ISR), so a viral link never hammers the database.
 */
export const revalidate = 300;

type Props = { params: Promise<{ slug: string }> };

/** No listing is pre-built (no database work at build time): each page is
 *  rendered on its first visit and then served from the edge cache (ISR). */
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const p = await loadPublicProduct(slug);
  if (!p) return { title: 'Product not available', robots: { index: false, follow: true } };

  const url = `${siteUrl()}/product/${p.slug}`;
  const unit = p.salePriceCents ?? p.priceCents;
  const price = formatMoney(unit, p.currency || 'ZAR');
  const title = `${p.name} — ${price}`;
  const description = plainSnippet(`${price} from ${p.store.name}. ${p.description}`, 160);
  const images = p.images.length > 0
    ? p.images.slice(0, 1).map((i) => ({ url: productImageUrl(i.id), alt: p.name }))
    : [{ url: '/og-image.jpg', width: 1344, height: 768, alt: 'Green Gate' }];

  return {
    title: p.name,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'website', siteName: 'Green Gate', url, title, description, images },
    twitter: { card: 'summary_large_image', title, description, images: images.map((i) => i.url) },
    other: {
      'product:price:amount': (unit / 100).toFixed(2),
      'product:price:currency': p.currency || 'ZAR',
    },
  };
}

export default async function ProductLandingPage({ params }: Props) {
  const { slug } = await params;
  const p = await loadPublicProduct(slug);
  if (!p) notFound();

  const url = `${siteUrl()}/product/${p.slug}`;
  const unit = p.salePriceCents ?? p.priceCents;
  const currency = p.currency || 'ZAR';
  const inStock = p.variants.length > 0 ? p.variants.some((v) => v.stock > 0) : p.stock > 0;
  const image = p.images[0] ? productImageUrl(p.images[0].id) : null;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    description: plainSnippet(p.description, 5000),
    url,
    image: p.images.map((i) => productImageUrl(i.id)),
    sku: p.variants[0]?.sku ?? p.id,
    itemCondition: conditionSchema(p.condition),
    ...(p.brand ? { brand: { '@type': 'Brand', name: p.brand } } : {}),
    ...(p.category ? { category: p.category.name } : {}),
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: currency,
      price: (unit / 100).toFixed(2),
      availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: conditionSchema(p.condition),
      seller: { '@type': 'Organization', name: p.store.name, url: `${siteUrl()}/store/${p.store.slug}` },
    },
    ...(p.ratingCount > 0
      ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: p.ratingAvg.toFixed(1), reviewCount: p.ratingCount, bestRating: 5, worstRating: 1 } }
      : {}),
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      <SpaLanding hash={`#/product/${p.slug}`}>
        <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-6">
          <a href="/" className="flex items-center gap-2 text-sm font-bold tracking-[0.18em]">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <GateMark className="h-5 w-5" />
            </span>
            GREEN <span className="text-primary">GATE</span>
          </a>
          <article className="grid gap-6 md:grid-cols-2">
            {image && (
              <img src={image} alt={p.name} className="aspect-square w-full rounded-lg border bg-white object-contain" />
            )}
            <div className="flex flex-col gap-3">
              {p.brand && <p className="text-sm text-muted-foreground">{p.brand}</p>}
              <h1 className="text-2xl font-bold">{p.name}</h1>
              <p className="text-xl font-semibold text-primary">
                {formatMoney(unit, currency)}
                {p.salePriceCents !== null && p.salePriceCents < p.priceCents && (
                  <span className="ml-2 text-sm font-normal text-muted-foreground line-through">{formatMoney(p.priceCents, currency)}</span>
                )}
              </p>
              <p className="text-sm">{inStock ? 'In stock' : 'Out of stock'}</p>
              <p className="text-sm">
                Sold by <a className="font-medium text-primary hover:underline" href={`/store/${p.store.slug}`}>{p.store.name}</a>
                {p.store.location ? ` · ${p.store.location}` : ''}
              </p>
              {p.ratingCount > 0 && (
                <p className="text-sm text-muted-foreground">Rated {p.ratingAvg.toFixed(1)} / 5 from {p.ratingCount} review{p.ratingCount === 1 ? '' : 's'}</p>
              )}
              <p className="whitespace-pre-line text-sm text-muted-foreground">{p.description}</p>
            </div>
          </article>
        </main>
      </SpaLanding>
    </>
  );
}
