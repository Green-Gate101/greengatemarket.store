'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { Heart, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { formatMoney, type ProductSummary } from '@/lib/types';
import { navigate } from './header';
import { useGuestCart } from './guest-cart';

export function ProductCard({ product, saved }: { product: ProductSummary; saved?: boolean }) {
  const { data: session } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const discount = product.salePriceCents
    ? Math.round(((product.priceCents - product.salePriceCents) / product.priceCents) * 100)
    : 0;
  // Products with sizes keep their stock on the variants (the product row
  // stays 0): count those, and send the buyer to pick a size instead of
  // adding the product without one (which the cart refuses).
  const soldOut = product.stock + (product.variantStock ?? 0) <= 0;
  const pickSize = Boolean(product.hasVariants) && !soldOut;

  const wishlist = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/wishlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: product.id }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not update wishlist');
      return res.json();
    },
    onSuccess: (data: { saved: boolean }) => {
      toast({ title: data.saved ? 'Saved to wishlist' : 'Removed from wishlist', description: product.name });
      queryClient.invalidateQueries({ queryKey: ['wishlist'] });
    },
    onError: (e: Error) => toast({ title: 'Wishlist', description: e.message, variant: 'destructive' }),
  });

  const addGuest = () => {
    useGuestCart.getState().add({
      productId: product.id,
      variantId: null,
      name: product.name,
      image: product.image,
      unitPriceCents: product.salePriceCents ?? product.priceCents,
      slug: product.slug,
      storeName: product.store.name,
    });
    toast({ title: 'Added to cart', description: `${product.name} — sign in to check out.` });
  };

  const addToCart = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: product.id, quantity: 1 }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not add to cart');
      return res.json();
    },
    onSuccess: () => {
      toast({ title: 'Added to cart', description: product.name });
      queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
    onError: (e: Error) => toast({ title: 'Cart', description: e.message, variant: 'destructive' }),
  });

  return (
    <article className="group flex flex-col overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md">
      <button
        className="relative aspect-square w-full overflow-hidden bg-muted"
        onClick={() => navigate({ name: 'product', slug: product.slug })}
        aria-label={`View ${product.name}`}
      >
        {product.image ? (
           
          <img src={product.image} alt={product.name} loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">No image</div>
        )}
        {discount > 0 && <Badge className="absolute left-2 top-2 bg-primary">-{discount}%</Badge>}
        {soldOut && <Badge variant="secondary" className="absolute right-2 top-2">Sold out</Badge>}
      </button>

      <div className="flex flex-1 flex-col gap-1.5 p-3">
        {/* A real link to the crawlable /product/<slug> page (search engines
            follow it; new-tab/middle-click open it), while a plain click keeps
            the instant in-app hash navigation. */}
        <a
          href={`/product/${product.slug}`}
          className="line-clamp-2 text-left text-sm font-medium leading-snug hover:text-primary"
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            navigate({ name: 'product', slug: product.slug });
          }}
        >
          {product.name}
        </a>
        <p className="text-xs text-muted-foreground">{product.store.name}</p>
        {product.ratingCount > 0 && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Star className="h-3 w-3 fill-primary text-primary" aria-hidden />
            {product.ratingAvg} ({product.ratingCount})
          </p>
        )}
        <div className="mt-auto flex items-end justify-between pt-1">
          <div>
            <p className="text-sm font-bold">
              {formatMoney(product.salePriceCents ?? product.priceCents)}
            </p>
            {product.salePriceCents && (
              <p className="text-xs text-muted-foreground line-through">{formatMoney(product.priceCents)}</p>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={saved ? 'Remove from wishlist' : 'Add to wishlist'}
              disabled={!session || wishlist.isPending}
              onClick={(e) => {
                e.stopPropagation();
                if (!session) {
                  toast({ title: 'Sign in to save items', description: 'Create a free account to use your wishlist.' });
                  return;
                }
                wishlist.mutate();
              }}
            >
              <Heart className={`h-4 w-4 ${saved ? 'fill-primary text-primary' : ''}`} />
            </Button>
            <Button
              size="sm"
              className="h-8"
              disabled={soldOut || addToCart.isPending}
              onClick={(e) => {
                e.stopPropagation();
                if (pickSize) navigate({ name: 'product', slug: product.slug });
                else if (session) addToCart.mutate();
                else addGuest();
              }}
            >
              {soldOut ? 'Sold out' : pickSize ? 'Choose' : 'Add'}
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}
