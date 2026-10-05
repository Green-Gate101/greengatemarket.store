'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ProductImage } from './product-image';
import { formatZAR } from '@/lib/format';
import type { ProductDto } from '@/lib/types';
import { PackageCheck, PackageX, Plus, SearchX, Sparkles } from 'lucide-react';

export function ProductCard({
  product,
  onOpen,
  onAdd,
}: {
  product: ProductDto;
  onOpen: (p: ProductDto) => void;
  onAdd: (p: ProductDto) => void;
}) {
  const out = product.stock <= 0;
  return (
    <Card className="group flex flex-col overflow-hidden transition-shadow hover:shadow-md">
      <button
        onClick={() => onOpen(product)}
        className="relative block bg-white p-3 text-left focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={`View ${product.name}`}
      >
        <ProductImage
          src={product.imageData}
          alt={product.name}
          className="aspect-square w-full rounded-md object-contain transition-transform duration-200 group-hover:scale-[1.03]"
        />
        {out ? (
          <Badge variant="secondary" className="absolute left-4 top-4 gap-1">
            <PackageX className="h-3 w-3" aria-hidden /> Sold out
          </Badge>
        ) : product.stock <= 3 ? (
          <Badge variant="outline" className="absolute left-4 top-4 bg-amber-50 text-amber-700 border-amber-200">
            Only {product.stock} left
          </Badge>
        ) : null}
      </button>
      <CardContent className="flex-1 px-4 pt-1 pb-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{product.seller?.storeName}</p>
        <button
          onClick={() => onOpen(product)}
          className="line-clamp-2 text-left text-sm font-medium leading-snug hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {product.name}
        </button>
        <p className="mt-1.5 text-base font-semibold tabular-nums">{formatZAR(product.price)}</p>
      </CardContent>
      <CardFooter className="px-4 pb-4 pt-0">
        <Button
          size="sm"
          className="w-full gap-1.5"
          disabled={out}
          onClick={() => onAdd(product)}
        >
          {out ? 'Sold out' : (
            <>
              <Plus className="h-4 w-4" aria-hidden /> Add to cart
            </>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}

export function ProductCardSkeleton() {
  return (
    <Card className="overflow-hidden">
      <Skeleton className="m-3 aspect-square w-[calc(100%-1.5rem)] rounded-md" />
      <CardContent className="space-y-2 px-4 pt-0">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-8 w-full" />
      </CardContent>
    </Card>
  );
}

export function EmptyResults({ query }: { query: string }) {
  return (
    <div className="col-span-full flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
      <SearchX className="h-10 w-10 text-muted-foreground/50" aria-hidden />
      <h3 className="mt-3 text-base font-medium">No products found</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {query ? `Nothing matches “${query}”. Try a different search or browse a category.` : 'No products in this category yet — check back soon.'}
      </p>
    </div>
  );
}

export function WhiteBgNote() {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <Sparkles className="h-3 w-3 text-primary" aria-hidden />
      Auto white-background photo
    </span>
  );
}

export function StockPill({ stock }: { stock: number }) {
  if (stock <= 0) {
    return (
      <Badge variant="secondary" className="gap-1">
        <PackageX className="h-3 w-3" aria-hidden /> Sold out
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 bg-emerald-50 text-emerald-700 border-emerald-200">
      <PackageCheck className="h-3 w-3" aria-hidden /> {stock} in stock
    </Badge>
  );
}
