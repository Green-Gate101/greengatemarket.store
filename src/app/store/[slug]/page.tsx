import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GateMark } from '@/components/greengate/brand';
import { SpaLanding } from '@/components/greengate/spa-landing';
import { formatMoney } from '@/lib/types';
import { jsonLdScript, loadPublicStore, plainSnippet, productImageUrl, siteUrl, storeLogoUrl } from '@/lib/seo';

/**
 * Crawlable store page — /store/<slug> (see src/lib/seo.ts). Lists the
 * store's newest live products as plain links, so crawlers discover every
 * /product/<slug> page from here. Edge-cached for 5 minutes (ISR).
 */
export const revalidate = 300;

type Props = { params: Promise<{ slug: string }> };

/** No store is pre-built (no database work at build time): each page is
 *  rendered on its first visit and then served from the edge cache (ISR). */
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const s = await loadPublicStore(slug);
  if (!s) return { title: 'Store not available', robots: { index: false, follow: true } };

  const url = `${siteUrl()}/store/${s.slug}`;
  const title = `${s.name} on Green Gate`;
  const description = plainSnippet(
    s.description?.trim() || `Shop ${s.name}${s.location ? ` (${s.location})` : ''} on Green Gate — real sellers, nationwide courier delivery.`,
    160,
  );
  const images = s.hasLogo
    ? [{ url: storeLogoUrl(s.id), alt: s.name }]
    : [{ url: '/og-image.jpg', width: 1344, height: 768, alt: 'Green Gate' }];

  return {
    title: s.name,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'website', siteName: 'Green Gate', url, title, description, images },
    twitter: { card: s.hasLogo ? 'summary' : 'summary_large_image', title, description, images: images.map((i) => i.url) },
  };
}

export default async function StoreLandingPage({ params }: Props) {
  const { slug } = await params;
  const s = await loadPublicStore(slug);
  if (!s) notFound();

  const url = `${siteUrl()}/store/${s.slug}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: s.name,
    url,
    ...(s.hasLogo ? { logo: storeLogoUrl(s.id) } : {}),
    ...(s.description ? { description: plainSnippet(s.description, 5000) } : {}),
    ...(s.location ? { address: { '@type': 'PostalAddress', addressLocality: s.location, addressCountry: 'ZA' } } : {}),
    ...(s.ratingCount > 0
      ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: (s.ratingSum / s.ratingCount).toFixed(1), reviewCount: s.ratingCount, bestRating: 5, worstRating: 1 } }
      : {}),
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      <SpaLanding hash={`#/store/${s.slug}`}>
        <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-6">
          <a href="/" className="flex items-center gap-2 text-sm font-bold tracking-[0.18em]">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <GateMark className="h-5 w-5" />
            </span>
            GREEN <span className="text-primary">GATE</span>
          </a>
          <header className="flex items-center gap-4">
            {s.hasLogo && (
              <img src={storeLogoUrl(s.id)} alt={s.name} className="h-16 w-16 rounded-lg border bg-white object-contain" />
            )}
            <div>
              <h1 className="text-2xl font-bold">{s.name}</h1>
              {s.location && <p className="text-sm text-muted-foreground">{s.location}</p>}
            </div>
          </header>
          {s.description && <p className="whitespace-pre-line text-sm text-muted-foreground">{s.description}</p>}
          <section aria-label={`Products from ${s.name}`}>
            {s.products.length === 0 ? (
              <p className="text-sm text-muted-foreground">No live listings yet.</p>
            ) : (
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
                {s.products.map((p) => (
                  <li key={p.slug}>
                    <a href={`/product/${p.slug}`} className="block rounded-lg border p-2 hover:border-primary">
                      {p.images[0] && (
                        <img src={productImageUrl(p.images[0].id)} alt={p.name} loading="lazy" className="aspect-square w-full rounded-md bg-white object-contain" />
                      )}
                      <span className="mt-2 block text-sm font-medium">{p.name}</span>
                      <span className="block text-sm text-primary">{formatMoney(p.salePriceCents ?? p.priceCents, p.currency || 'ZAR')}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>
      </SpaLanding>
    </>
  );
}
