'use client';

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { Sparkles, TrendingUp, Layers } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { ProductCard } from './product-card';
import { getGuestId } from './guest-cart';
import { hasOptionalConsent } from './consent';
import type { ProductSummary } from '@/lib/types';
import { readJson } from '@/lib/utils';

interface RecommendationsResponse {
  products: ProductSummary[];
  source: 'personalized' | 'trending' | 'similar';
  attribution: Record<string, { cf: number; content: number; pop: number }>;
}

interface RecommendRailProps {
  /** Exclude a product (the one currently open on the product page). */
  excludeSlug?: string;
  /** Return "more like this" neighbours for a product id instead of personalised picks. */
  similarTo?: string;
  /** Fixed heading override. */
  title?: string;
}

/**
 * ML recommendation rail.
 *
 * - Renders proper skeleton loading while the engine ranks products.
 * - Reports impressions back to the engine so the ensemble can learn which
 *   signal sources actually earn clicks (clicks are reported on card click).
 * - Renders nothing when there is nothing real to recommend — no filler.
 */
export function RecommendRail({ excludeSlug, similarTo, title }: RecommendRailProps) {
  const { data: session, status } = useSession();
  const railRef = useRef<HTMLDivElement>(null);
  const reportedImpressions = useRef(false);

  const params = new URLSearchParams();
  params.set('limit', similarTo ? '6' : '8');
  if (excludeSlug) params.set('exclude', excludeSlug);
  if (similarTo) params.set('similar', similarTo);
  // Anonymous profiling only with cookie consent; signed-in personalisation
  // is part of the account service (disclosed in the Privacy Policy).
  if (status !== 'loading' && !session && hasOptionalConsent()) params.set('guest', getGuestId());

  const { data, isLoading } = useQuery<RecommendationsResponse>({
    queryKey: ['recommendations', similarTo ?? 'home', session ? session.user.id : 'guest', excludeSlug ?? ''],
    queryFn: async () => {
      const res = await fetch(`/api/recommendations?${params.toString()}`);
      if (!res.ok) throw new Error('Could not load recommendations');
      return readJson(res);
    },
    staleTime: 60_000,
  });

  // Impression feedback: report once per render of real results.
  useEffect(() => {
    if (!data || data.products.length === 0 || similarTo || reportedImpressions.current) return;
    // typeof: a bare reference throws on browsers without the API.
    if (typeof IntersectionObserver === 'undefined') return;
    reportedImpressions.current = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          if (!hasOptionalConsent()) return;
          void fetch('/api/recommendations/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ impressions: Object.values(data.attribution) }),
          }).catch(() => undefined);
        }
      },
      { threshold: 0.3 },
    );
    if (railRef.current) observer.observe(railRef.current);
    return () => observer.disconnect();
  }, [data, similarTo]);

  // Click feedback: learn from recommendation clicks (capture-phase, no child changes).
  const onClickCapture = (e: React.MouseEvent) => {
    if (!data || similarTo) return;
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-rec-product-id]');
    const productId = card?.dataset.recProductId;
    if (!productId || !data.attribution[productId]) return;
    if (!hasOptionalConsent()) return;
    void fetch('/api/recommendations/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ click: { productId, attribution: data.attribution[productId] } }),
    }).catch(() => undefined);
  };

  if (isLoading) {
    return (
      <section className="mt-10" aria-label="Loading recommendations" aria-busy="true">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-5" />
          <Skeleton className="h-6 w-56" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="aspect-square w-full rounded-lg" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  const products = data?.products ?? [];
  if (products.length === 0) return null;

  const source = data?.source ?? 'trending';
  const heading =
    title ??
    (source === 'personalized' ? 'Recommended for you'
      : source === 'similar' ? 'More like this'
      : 'Popular right now');
  const sub =
    source === 'personalized'
      ? 'Inspired by your shopping activity.'
      : source === 'similar'
        ? undefined
        : undefined;

  const HeadingIcon = source === 'personalized' ? Sparkles : source === 'similar' ? Layers : TrendingUp;

  return (
    <section className="mt-10" aria-label={heading} ref={railRef} onClickCapture={onClickCapture}>
      <div className="flex items-baseline gap-2">
        <HeadingIcon className="h-5 w-5 shrink-0 self-center text-primary" aria-hidden />
        <h2 className="text-lg font-bold">{heading}</h2>
        {sub && <p className="ml-2 hidden text-xs text-muted-foreground sm:block">{sub}</p>}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {products.map((p) => (
          <div key={p.id} data-rec-product-id={p.id}>
            <ProductCard product={p} />
          </div>
        ))}
      </div>
    </section>
  );
}
