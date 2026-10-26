'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MapPin, PackageOpen, Star } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import type { ProductSummary } from '@/lib/types';
import { ProductCard } from './product-card';
import { navigate } from './header';
import { readJson } from '@/lib/utils';

interface StoreResponse {
  store: {
    id: string; slug: string; name: string; description: string | null;
    logoData: string | null; bannerData: string | null; location: string; createdAt: string;
    ratingAvg?: number | null; ratingCount?: number;
  };
  products: ProductSummary[];
  /** All live listings of the store (the first page shows up to 48). */
  total: number;
}

const STORE_PAGE_SIZE = 48;

export function StoreView({ slug }: { slug: string }) {
  const { data, isLoading, isError, error, refetch } = useQuery<StoreResponse>({
    queryKey: ['store', slug],
    queryFn: async () => {
      // Resolve the store DIRECTLY by slug (works at any directory size) and
      // fall back to the directory page only if the direct lookup fails.
      const [directRes, productsRes] = await Promise.all([
        fetch(`/api/sellers?slug=${encodeURIComponent(slug)}`).then((r) => {
          if (r.ok) return readJson(r);
          if (r.status === 404) return { store: null };
          throw new Error('load');
        }) as Promise<{ store: { id: string; slug: string; name: string; description: string | null; logoData: string | null; bannerData: string | null; location: string; createdAt: string; ratingAvg?: number | null; ratingCount?: number } | null }>,
        fetch(`/api/products?store=${encodeURIComponent(slug)}&pageSize=${STORE_PAGE_SIZE}`).then((r) => {
          if (!r.ok) throw new Error('load');
          return readJson(r);
        }) as Promise<{ products: ProductSummary[]; total?: number }>,
      ]);
      let store = directRes.store;
      if (!store) {
        const storeRes = (await fetch(`/api/sellers?mine=0`).then((r) => {
          if (!r.ok) throw new Error('load');
          return readJson(r);
        })) as { stores: { id: string; slug: string; name: string; description: string | null; logoData: string | null; bannerData: string | null; location: string; createdAt: string; ratingAvg?: number | null; ratingCount?: number }[] };
        store = storeRes.stores.find((s) => s.slug === slug) ?? null;
      }
      if (!store) throw new Error('not found');
      return { store, products: productsRes.products, total: productsRes.total ?? productsRes.products.length };
    },
  });

  // Stores with more than one page of listings: "Show more" appends the
  // next page (before, only the first 48 were ever reachable and the count
  // said 48). Reset when another store opens in the same view.
  const [more, setMore] = useState<ProductSummary[]>([]);
  const [morePages, setMorePages] = useState(0);
  const [moreFor, setMoreFor] = useState(slug);
  if (moreFor !== slug) {
    setMoreFor(slug);
    setMore([]);
    setMorePages(0);
  }
  const loadMore = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/products?store=${encodeURIComponent(slug)}&pageSize=${STORE_PAGE_SIZE}&page=${morePages + 2}`);
      if (!res.ok) throw new Error('We could not load more products — try again.');
      return (await readJson(res)) as { products: ProductSummary[] };
    },
    onSuccess: (d) => {
      setMore((m) => [...m, ...d.products.filter((p) => !m.some((x) => x.id === p.id))]);
      setMorePages((n) => n + 1);
    },
  });

  // Tab/history title follows the open store (same format as the
  // server-rendered /store/<slug> page).
  const storeName = data?.store.name;
  useEffect(() => {
    if (storeName) document.title = `${storeName} — Green Gate`;
  }, [storeName]);

  if (isLoading) {
    return <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6"><Skeleton className="h-40 w-full" /><Skeleton className="mt-6 h-72 w-full" /></main>;
  }

  // Anything but a genuine "not found" (a server error, a dropped connection)
  // is a load failure — never "Store not found".
  if (isError && !(error instanceof Error && error.message === 'not found')) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center gap-4 px-4 py-20 text-center">
        <PackageOpen className="h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">We could not load this store</p>
        <p className="text-xs text-muted-foreground">Check your connection and try again.</p>
        <Button onClick={() => refetch()}>Try again</Button>
      </main>
    );
  }

  if (isError || !data) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center gap-4 px-4 py-20 text-center">
        <PackageOpen className="h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">Store not found</p>
        <Button variant="outline" onClick={() => navigate({ name: 'store' })}>Back to marketplace</Button>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
      <section className="overflow-hidden rounded-lg border bg-card">
        <div className="h-28 bg-secondary sm:h-40">
          {data.store.bannerData && (
             
            <img src={data.store.bannerData} alt={`${data.store.name} banner`} className="h-full w-full object-cover" />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4 p-4 sm:p-6">
          <div className="h-16 w-16 overflow-hidden rounded-md border bg-white">
            {data.store.logoData && (
               
              <img src={data.store.logoData} alt={`${data.store.name} logo`} className="h-full w-full object-contain" />
            )}
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold">{data.store.name}</h1>
            {data.store.description && <p className="mt-0.5 text-sm text-muted-foreground">{data.store.description}</p>}
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-3.5 w-3.5" /> {data.store.location} · member since {new Date(data.store.createdAt).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' })}
            </p>
            {(data.store.ratingCount ?? 0) > 0 && (
              <p className="mt-1 flex items-center gap-1 text-xs font-medium" aria-label={`Store rating ${data.store.ratingAvg} out of 5 from ${data.store.ratingCount} reviews`}>
                <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" aria-hidden />
                {data.store.ratingAvg} · {data.store.ratingCount} review{data.store.ratingCount === 1 ? '' : 's'}
              </p>
            )}
          </div>
          <p className="ml-auto text-sm text-muted-foreground">{data.total} live listing{data.total === 1 ? '' : 's'}</p>
        </div>
      </section>

      <section className="mt-6" aria-label={`Products from ${data.store.name}`}>
        {data.products.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center">
            <p className="text-sm font-medium">This store has no live products yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Check back soon.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {[...data.products, ...more.filter((p) => !data.products.some((x) => x.id === p.id))].map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
            {data.products.length + more.length < data.total && (
              <div className="mt-6 flex flex-col items-center gap-2">
                <Button variant="outline" onClick={() => loadMore.mutate()} disabled={loadMore.isPending} data-testid="store-show-more">
                  {loadMore.isPending ? 'Loading…' : `Show more products (${data.total - data.products.length - more.length} more)`}
                </Button>
                {loadMore.isError && <p className="text-xs text-destructive" role="alert">{(loadMore.error as Error).message}</p>}
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
