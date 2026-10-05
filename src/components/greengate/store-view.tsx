'use client';

import { useQuery } from '@tanstack/react-query';
import { MapPin, PackageOpen } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import type { ProductSummary } from '@/lib/types';
import { ProductCard } from './product-card';
import { navigate } from './header';

interface StoreResponse {
  store: {
    id: string; slug: string; name: string; description: string | null;
    logoData: string | null; bannerData: string | null; location: string; createdAt: string;
  };
  products: ProductSummary[];
}

export function StoreView({ slug }: { slug: string }) {
  const { data, isLoading, isError } = useQuery<StoreResponse>({
    queryKey: ['store', slug],
    queryFn: async () => {
      const [storeRes, productsRes] = await Promise.all([
        fetch(`/api/sellers?mine=0`).then((r) => r.json()) as Promise<{ stores: { slug: string; name: string; description: string | null; logoData: string | null; location: string; createdAt: string }[] }>,
        fetch(`/api/products?store=${encodeURIComponent(slug)}&pageSize=48`).then((r) => r.json()) as Promise<{ products: ProductSummary[] }>,
      ]);
      const store = storeRes.stores.find((s) => s.slug === slug);
      if (!store) throw new Error('not found');
      return { store, products: productsRes.products };
    },
  });

  if (isLoading) {
    return <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6"><Skeleton className="h-40 w-full" /><Skeleton className="mt-6 h-72 w-full" /></main>;
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
          <div className="h-16 w-16 overflow-hidden rounded-md border bg-white dark:bg-muted">
            {data.store.logoData && (
               
              <img src={data.store.logoData} alt={`${data.store.name} logo`} className="h-full w-full object-cover" />
            )}
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold">{data.store.name}</h1>
            {data.store.description && <p className="mt-0.5 text-sm text-muted-foreground">{data.store.description}</p>}
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-3.5 w-3.5" /> {data.store.location} · member since {new Date(data.store.createdAt).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' })}
            </p>
          </div>
          <p className="ml-auto text-sm text-muted-foreground">{data.products.length} live listing{data.products.length === 1 ? '' : 's'}</p>
        </div>
      </section>

      <section className="mt-6" aria-label={`Products from ${data.store.name}`}>
        {data.products.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center">
            <p className="text-sm font-medium">This store has no live products yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Check back soon.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {data.products.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
