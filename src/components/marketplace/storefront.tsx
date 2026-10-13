'use client';

import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ProductCard, ProductCardSkeleton, EmptyResults } from './product-card';
import { CATEGORIES, type ProductDto } from '@/lib/types';
import { Search, ShieldCheck, Truck, Sparkles } from 'lucide-react';

async function fetchProducts(query: string, category: string): Promise<ProductDto[]> {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  if (category !== 'All') params.set('category', category);
  const res = await fetch(`/api/products?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to load products');
  const data = await res.json();
  return data.products ?? [];
}

async function fetchMarketplaceStats(): Promise<{ sellers: number; products: number; orders: number } | null> {
  const res = await fetch('/api/analytics');
  if (!res.ok) return null;
  const data = await res.json();
  return data.marketplace ?? null;
}

export function Storefront({ onOpenProduct, onAddToCart }: {
  onOpenProduct: (p: ProductDto) => void;
  onAddToCart: (p: ProductDto) => void;
}) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [category, setCategory] = useState('All');

  // Debounce search input; setState fires inside a timer callback only.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), query ? 280 : 0);
    return () => clearTimeout(t);
  }, [query]);

  const productsQuery = useQuery({
    queryKey: ['products', debouncedQuery, category],
    queryFn: () => fetchProducts(debouncedQuery, category),
    placeholderData: keepPreviousData,
  });

  const statsQuery = useQuery({
    queryKey: ['marketplace-stats'],
    queryFn: fetchMarketplaceStats,
    staleTime: 60_000,
  });

  const products = productsQuery.data;
  const loading = productsQuery.isPending;
  const switching = productsQuery.isPlaceholderData;
  const stats = statsQuery.data ?? null;

  const heroStats = [
    { label: 'Independent sellers', value: stats?.sellers ?? null },
    { label: 'Live products', value: stats?.products ?? null },
    { label: 'Orders shipped', value: stats?.orders ?? null },
  ];

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 sm:px-6">
      {/* Hero */}
      <section className="mt-6 rounded-2xl border bg-gradient-to-br from-emerald-50/80 via-background to-amber-50/60 px-6 py-10 sm:px-10 sm:py-14">
        <div className="max-w-2xl">
          <p className="inline-flex items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
            Every product photo arrives on a clean white studio background
          </p>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
            South Africa&apos;s marketplace for independent sellers
          </h1>
          <p className="mt-3 text-base leading-relaxed text-muted-foreground sm:text-lg">
            Discover handcrafted goods, gourmet food and outdoor gear from local stores —
            or open your own store and start selling in minutes.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button size="lg" onClick={() => document.getElementById('product-search')?.focus()}>
              Start shopping
            </Button>
          </div>
          <dl className="mt-8 grid max-w-md grid-cols-3 gap-4">
            {heroStats.map((s) => (
              <div key={s.label}>
                <dt className="text-xs text-muted-foreground">{s.label}</dt>
                <dd className="text-xl font-semibold tabular-nums">
                  {s.value === null ? '—' : s.value.toLocaleString('en-ZA')}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Feature bar */}
      <section className="mt-6 grid gap-3 sm:grid-cols-3" aria-label="Marketplace benefits">
        {[
          { icon: Sparkles, title: 'Instant product photos', text: 'Uploads are cleaned and composited onto white automatically.' },
          { icon: Truck, title: 'Nationwide courier', text: 'Economy, standard and express delivery to every province.' },
          { icon: ShieldCheck, title: 'Buyer protection', text: 'Receipts by email and courier tracking on every order.' },
        ].map((f) => (
          <div key={f.title} className="flex items-start gap-3 rounded-lg border bg-card p-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <f.icon className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <div>
              <p className="text-sm font-medium">{f.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{f.text}</p>
            </div>
          </div>
        ))}
      </section>

      {/* Search + categories */}
      <section className="mt-10" aria-label="Product catalogue">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Browse the marketplace</h2>
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="product-search"
              type="search"
              placeholder="Search products, stores, categories…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
              aria-label="Search products"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filter by category">
          {['All', ...CATEGORIES].map((c) => (
            <Button
              key={c}
              variant={category === c ? 'default' : 'outline'}
              size="sm"
              className="rounded-full"
              onClick={() => setCategory(c)}
              aria-pressed={category === c}
            >
              {c}
            </Button>
          ))}
        </div>

        <div className={`mt-6 grid grid-cols-1 gap-4 transition-opacity sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 ${switching ? 'opacity-60' : ''}`}>
          {loading || products === undefined
            ? Array.from({ length: 8 }).map((_, i) => <ProductCardSkeleton key={i} />)
            : products.length === 0
              ? <EmptyResults query={debouncedQuery} />
              : products.map((p) => (
                  <ProductCard key={p.id} product={p} onOpen={onOpenProduct} onAdd={onAddToCart} />
                ))}
        </div>
      </section>
    </main>
  );
}
