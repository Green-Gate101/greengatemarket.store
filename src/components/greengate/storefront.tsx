'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SlidersHorizontal, ChevronLeft, ChevronRight, SearchX, Truck, BadgeCheck, Package, MapPin, Store as StoreIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';
import { ProductCard } from './product-card';
import { RecommendRail } from './recommendations';
import { navigate, type Category, type Route } from './header';
import type { ProductSummary } from '@/lib/types';

interface StorefrontProps {
  route: Route;
}

/** A store matching the search (GET /api/sellers?q=). */
interface StoreHit {
  id: string;
  slug: string;
  name: string;
  location: string;
  logoData: string | null;
  productCount: number;
}

interface ProductsResponse {
  products: ProductSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export function Storefront({ route }: StorefrontProps) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('newest');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [inStock, setInStock] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  const params = new URLSearchParams();
  if (route.q) params.set('q', route.q);
  if (route.slug) params.set('category', route.slug);
  if (sort !== 'newest') params.set('sort', sort);
  if (minPrice) params.set('minPrice', minPrice);
  if (maxPrice) params.set('maxPrice', maxPrice);
  if (inStock) params.set('inStock', '1');
  params.set('page', String(page));

  const { data, isLoading, isError, refetch } = useQuery<ProductsResponse>({
    queryKey: ['products', params.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/products?${params.toString()}`);
      if (!res.ok) throw new Error('Could not load products');
      return res.json();
    },
  });

  const { data: cats } = useQuery<{ categories: Category[] }>({
    queryKey: ['categories'],
    // A failed load must throw (so it retries) — a cached error body left
    // sellers with no categories to pick for minutes.
    queryFn: async () => {
      const res = await fetch('/api/categories');
      if (!res.ok) throw new Error('Could not load categories');
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  // Stores matching the search, shown above the products — a store can be
  // found by its name or town even when none of its listings match.
  const storeSearch = useQuery<{ stores: StoreHit[] }>({
    queryKey: ['store-search', route.q ?? ''],
    queryFn: async () => {
      const res = await fetch(`/api/sellers?q=${encodeURIComponent(route.q ?? '')}`);
      if (!res.ok) throw new Error('Could not load stores');
      return res.json();
    },
    enabled: Boolean(route.q),
  });
  const storeHits = route.q ? storeSearch.data?.stores ?? [] : [];

  const resetPage = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
      {/* Searching: results come first (the hero and recommendations pushed
          them below the fold on phones, so a search looked like it did nothing). */}
      {route.q ? (
        <h1 className="text-xl font-bold sm:text-2xl" data-testid="search-heading">
          Results for &ldquo;<span className="break-words">{route.q}</span>&rdquo;
        </h1>
      ) : (
      <>
      {/* Hero */}
      <section className="rounded-lg bg-secondary px-6 py-10 sm:px-10 sm:py-14">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">Soo good you wanna gate keep</p>
          <h1 className="mt-2 text-3xl font-bold leading-tight sm:text-4xl">
            Shop anything, sell anything — all in one marketplace
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
            Fashion, electronics, home, beauty, sports and more from sellers across South Africa —
            one marketplace for everyone. Fair prices, fast nationwide delivery and straightforward returns.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button size="lg" onClick={() => navigate({ name: 'store', slug: route.q ? undefined : 'women' })}>
              {route.q ? 'Browse all products' : 'Start shopping'}
            </Button>
            <Button size="lg" variant="outline" onClick={() => navigate({ name: 'sell' })}>
              Sell on Green Gate
            </Button>
          </div>
          {/* Trust strip — the marketplace basics, visible the way big apps show them */}
          <ul className="mt-7 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3 sm:gap-4">
            <li className="flex items-center gap-2">
              <Truck className="h-4 w-4 shrink-0 text-primary" aria-hidden /> Nationwide courier delivery
            </li>
            <li className="flex items-center gap-2">
              <BadgeCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden /> Real, reviewed sellers
            </li>
            <li className="flex items-center gap-2">
              <Package className="h-4 w-4 shrink-0 text-primary" aria-hidden /> Every order tracked
            </li>
          </ul>
        </div>
      </section>

      {/* ML recommendations — personalised, trending, or hidden when empty */}
      <RecommendRail />
      </>
      )}

      {route.q && (storeSearch.isError ? (
        <p className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="alert">
          We could not load matching stores.
          <Button variant="outline" size="sm" onClick={() => void storeSearch.refetch()}>Try again</Button>
        </p>
      ) : storeHits.length > 0 ? (
        <section className="mt-5" aria-label="Matching stores" data-testid="store-results">
          <h2 className="text-sm font-bold">Stores</h2>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 [&>*]:min-w-0">
            {storeHits.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => navigate({ name: 'store-page', slug: s.slug })}
                className="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent/40"
                data-testid="store-result"
              >
                <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-white">
                  {s.logoData ? (
                    <img src={s.logoData} alt="" className="h-full w-full object-contain" loading="lazy" />
                  ) : (
                    <StoreIcon className="h-5 w-5 text-muted-foreground" aria-hidden />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{s.name}</span>
                  <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                    <MapPin className="h-3 w-3 shrink-0" aria-hidden />
                    <span className="truncate">{s.location} · {s.productCount} live listing{s.productCount === 1 ? '' : 's'}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null)}

      {/* Category chips */}
      <section className="mt-8" aria-label="Categories">
        <div className="flex flex-wrap gap-2">
          <Button variant={!route.slug ? 'default' : 'outline'} size="sm" onClick={() => navigate({ name: 'store' })}>
            All
          </Button>
          {(cats?.categories ?? []).map((c) => (
            <Button
              key={c.slug}
              variant={route.slug === c.slug ? 'default' : 'outline'}
              size="sm"
              onClick={() => navigate({ name: 'store', slug: c.slug })}
            >
              {c.name}
            </Button>
          ))}
        </div>
      </section>

      {/* Toolbar */}
      <section className="mt-6 flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {data ? `${data.total} product${data.total === 1 ? '' : 's'}` : 'Loading…'}
          {route.q ? <> for “<span className="font-medium text-foreground">{route.q}</span>”</> : null}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
            <SlidersHorizontal className="h-4 w-4" /> Filters
          </Button>
          <Select value={sort} onValueChange={(v) => { setSort(v); setPage(1); }}>
            <SelectTrigger className="h-9 w-[170px]" aria-label="Sort products">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="popular">Most viewed</SelectItem>
              <SelectItem value="price_asc">Price: low to high</SelectItem>
              <SelectItem value="price_desc">Price: high to low</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      {showFilters && (
        <div className="mt-3 grid gap-3 rounded-lg border p-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="min-price" className="text-xs">Min price (R)</Label>
            <Input id="min-price" inputMode="numeric" value={minPrice} onChange={(e) => resetPage(setMinPrice)(e.target.value.replace(/\D/g, ''))} placeholder="0" />
          </div>
          <div>
            <Label htmlFor="max-price" className="text-xs">Max price (R)</Label>
            <Input id="max-price" inputMode="numeric" value={maxPrice} onChange={(e) => resetPage(setMaxPrice)(e.target.value.replace(/\D/g, ''))} placeholder="Any" />
          </div>
          <div className="flex items-end gap-2">
            <div className="flex items-center gap-2">
              <Switch id="in-stock" checked={inStock} onCheckedChange={(v) => { setInStock(v); setPage(1); }} />
              <Label htmlFor="in-stock" className="text-xs">In stock only</Label>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => { setMinPrice(''); setMaxPrice(''); setInStock(false); setSort('newest'); setPage(1); }}
            >
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* Grid */}
      <section className="mt-5" aria-label="Product results">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="aspect-square w-full rounded-lg" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border py-16 text-center">
            <p className="text-sm text-muted-foreground">Something went wrong while loading products.</p>
            <Button variant="outline" onClick={() => void refetch()}>Try again</Button>
          </div>
        ) : !data || data.products.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border bg-card py-16 text-center">
            <SearchX className="h-8 w-8 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">No products found</p>
            <p className="max-w-md text-xs text-muted-foreground">
              {route.q && storeHits.length > 0
                ? `No products match that search yet — ${storeHits.length === 1 ? 'the matching store is' : 'the matching stores are'} shown above.`
                : route.q
                ? 'Nothing matches that search yet. Try different keywords or browse all categories.'
                : 'There are no live listings in this category yet. Sellers can open a store and list real products in minutes.'}
            </p>
            <div className="flex gap-2">
              {(route.q || route.slug) && <Button variant="outline" onClick={() => navigate({ name: 'store' })}>Browse everything</Button>}
              <Button onClick={() => navigate({ name: 'sell' })}>Sell on Green Gate</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {data.products.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
            {totalPages > 1 && (
              <div className="mt-8 flex items-center justify-center gap-3">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="h-4 w-4" /> Previous
                </Button>
                <span className="text-sm text-muted-foreground">Page {data.page} of {totalPages}</span>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
