'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { Heart, Star, Truck, ShieldCheck, RotateCcw, ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { formatMoney, type ProductDetail } from '@/lib/types';
import { navigate } from './header';
import { useGuestCart, getGuestId } from './guest-cart';
import { RecommendRail } from './recommendations';

export function ProductView({ slug }: { slug: string }) {
  const { data: session } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [activeImage, setActiveImage] = useState(0);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [reviewText, setReviewText] = useState('');
  const [reviewRating, setReviewRating] = useState(5);

  const { data, isLoading, isError, refetch } = useQuery<{ product: ProductDetail }>({
    queryKey: ['product', slug],
    queryFn: async () => {
      const res = await fetch(`/api/products/${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error('Product unavailable');
      return res.json();
    },
  });

  // Real view event (once per mount) — feeds seller analytics and the
  // recommendation engine's learning (guest id included for anonymous shoppers).
  useEffect(() => {
    if (data?.product) {
      fetch(`/api/products/${data.product.id}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'view', guestId: session ? undefined : getGuestId() }),
      }).catch(() => undefined);
    }
  }, [data?.product, session]);

  const product = data?.product;
  // The first variant is the default selection — derived, not effect-synced.
  const defaultVariantId = product?.variants[0]?.id ?? null;
  const effectiveVariantId = variantId ?? defaultVariantId;
  const variant = useMemo(() => product?.variants.find((v) => v.id === effectiveVariantId) ?? null, [product, effectiveVariantId]);
  const stock = variant ? variant.stock : product?.stock ?? 0;
  const unit = variant?.priceCents ?? product?.salePriceCents ?? product?.priceCents ?? 0;

  const addGuest = () => {
    if (!product) return;
    useGuestCart.getState().add(
      {
        productId: product.id,
        variantId: effectiveVariantId,
        name: product.name,
        image: product.images[0]?.dataUrl ?? null,
        unitPriceCents: unit,
        slug: product.slug,
        storeName: product.store.name,
      },
      quantity,
    );
    toast({ title: 'Added to cart', description: `${product.name} × ${quantity}` });
  };

  const addToCart = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: product!.id, variantId: effectiveVariantId, quantity }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Could not add to cart');
      return res.json();
    },
    onSuccess: () => {
      toast({ title: 'Added to cart', description: `${product!.name} × ${quantity}` });
      queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
    onError: (e: Error) => toast({ title: 'Cart', description: e.message, variant: 'destructive' }),
  });

  const submitReview = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/products/${product!.id}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: reviewRating, body: reviewText }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Could not save review');
      return res.json();
    },
    onSuccess: () => {
      toast({ title: 'Review submitted', description: 'Thank you — your review is live.' });
      setReviewText('');
      void refetch();
    },
    onError: (e: Error) => toast({ title: 'Review', description: e.message, variant: 'destructive' }),
  });

  if (isLoading) {
    return (
      <main className="mx-auto grid w-full max-w-7xl flex-1 gap-8 px-4 py-6 sm:px-6 lg:grid-cols-2">
        <Skeleton className="aspect-square w-full rounded-lg" />
        <div className="space-y-4">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      </main>
    );
  }

  if (isError || !product) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center gap-4 px-4 py-24 text-center">
        <p className="text-sm font-medium">This product is not available.</p>
        <p className="text-xs text-muted-foreground">It may have been removed by the seller or is temporarily disabled.</p>
        <Button variant="outline" onClick={() => navigate({ name: 'store' })}>
          <ChevronLeft className="h-4 w-4" /> Back to marketplace
        </Button>
      </main>
    );
  }

  const discount = product.salePriceCents ? Math.round(((product.priceCents - product.salePriceCents) / product.priceCents) * 100) : 0;

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
      <button className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" onClick={() => navigate({ name: 'store' })}>
        <ChevronLeft className="h-4 w-4" /> All products
      </button>

      <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr]">
        {/* Gallery */}
        <div>
          <div className="overflow-hidden rounded-lg border bg-white dark:bg-muted">
            {product.images[activeImage] ? (
               
              <img src={product.images[activeImage].dataUrl} alt={`${product.name} — image ${activeImage + 1}`} className="aspect-square w-full object-cover" />
            ) : (
              <div className="flex aspect-square items-center justify-center text-sm text-muted-foreground">No image</div>
            )}
          </div>
          {product.images.length > 1 && (
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
              {product.images.map((img, i) => (
                <button
                  key={img.id}
                  className={`h-16 w-16 shrink-0 overflow-hidden rounded-md border-2 ${i === activeImage ? 'border-primary' : 'border-transparent'}`}
                  onClick={() => setActiveImage(i)}
                  aria-label={`Show image ${i + 1}`}
                >
                  { }
                  <img src={img.dataUrl} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Buy box */}
        <div className="flex flex-col gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              {product.brand && <Badge variant="secondary">{product.brand}</Badge>}
              {product.categoryName && <Badge variant="outline">{product.categoryName}</Badge>}
              {product.condition === 'pre_loved' && <Badge variant="outline">Pre-loved</Badge>}
            </div>
            <h1 className="mt-2 text-2xl font-bold leading-snug">{product.name}</h1>
            <button className="mt-1 text-sm text-primary hover:underline" onClick={() => navigate({ name: 'store-page', slug: product.store.slug })}>
              Visit {product.store.name} store
            </button>
            {product.ratingCount > 0 && (
              <p className="mt-2 flex items-center gap-1 text-sm">
                <Star className="h-4 w-4 fill-primary text-primary" aria-hidden />
                <span className="font-semibold">{product.ratingAvg}</span>
                <span className="text-muted-foreground">({product.ratingCount} review{product.ratingCount === 1 ? '' : 's'})</span>
              </p>
            )}
          </div>

          <div className="flex items-end gap-3">
            <p className="text-3xl font-bold">{formatMoney(unit)}</p>
            {product.salePriceCents && (
              <>
                <p className="text-base text-muted-foreground line-through">{formatMoney(product.priceCents)}</p>
                <Badge className="mb-1">-{discount}%</Badge>
              </>
            )}
          </div>

          {/* Variants */}
          {product.variants.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-medium">Choose an option</p>
              <div className="flex flex-wrap gap-2">
                {product.variants.map((v) => (
                  <button
                    key={v.id}
                    disabled={v.stock <= 0}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      v.id === effectiveVariantId ? 'border-primary bg-secondary font-medium text-primary' : 'hover:border-foreground/30'
                    }`}
                    onClick={() => setVariantId(v.id)}
                  >
                    {Object.entries(v.attributes).map(([k, val]) => `${k}: ${val}`).join(' · ')}
                    {v.stock <= 0 && ' (out of stock)'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Quantity + actions */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center rounded-md border">
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => setQuantity((q) => Math.max(1, q - 1))} aria-label="Decrease quantity">−</Button>
              <span className="w-8 text-center text-sm font-medium" aria-live="polite">{quantity}</span>
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => setQuantity((q) => Math.min(Math.max(stock, 1), 99, q + 1))} aria-label="Increase quantity">+</Button>
            </div>
            <p className="text-xs text-muted-foreground">{stock > 0 ? `${stock} in stock` : 'Out of stock'}</p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button
              size="lg"
              className="flex-1"
              disabled={stock <= 0 || addToCart.isPending}
              onClick={() => (session ? addToCart.mutate() : addGuest())}
            >
              {stock <= 0 ? 'Out of stock' : 'Add to Cart'}
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="flex-1"
              disabled={stock <= 0}
              onClick={() => {
                if (session) {
                  addToCart.mutate();
                  navigate({ name: 'account' });
                } else {
                  addGuest();
                  navigate({ name: 'signin' });
                }
              }}
            >
              Buy Now
            </Button>
            <Button
              size="lg"
              variant="ghost"
              aria-label="Add to wishlist"
              onClick={async () => {
                if (!session) {
                  toast({ title: 'Sign in to save items' });
                  return;
                }
                const res = await fetch('/api/wishlist', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ productId: product.id }),
                });
                const out = await res.json();
                toast({ title: out.saved ? 'Saved to wishlist' : 'Removed from wishlist' });
                queryClient.invalidateQueries({ queryKey: ['wishlist'] });
              }}
            >
              <Heart className="h-4 w-4" />
            </Button>
          </div>

          <Separator />

          <ul className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            <li className="flex items-center gap-1.5"><Truck className="h-4 w-4 text-primary" /> Courier delivery, quoted at checkout</li>
            <li className="flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-primary" /> Secure payment with order tracking</li>
            <li className="flex items-center gap-1.5"><RotateCcw className="h-4 w-4 text-primary" /> 7-day return window</li>
          </ul>

          <div>
            <h2 className="text-sm font-semibold">Description</h2>
            <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{product.description}</p>
            {product.tags && (
              <p className="mt-2 flex flex-wrap gap-1">
                {product.tags.split(',').map((t) => t.trim()).filter(Boolean).map((t) => (
                  <Badge key={t} variant="secondary">{t}</Badge>
                ))}
              </p>
            )}
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <div className="flex justify-between border-b py-1"><dt>Condition</dt><dd className="capitalize">{product.condition.replace('_', ' ')}</dd></div>
              <div className="flex justify-between border-b py-1"><dt>Weight</dt><dd>{(product.weightGrams / 1000).toFixed(1)} kg</dd></div>
              <div className="flex justify-between border-b py-1"><dt>Seller</dt><dd>{product.store.name}</dd></div>
              <div className="flex justify-between border-b py-1"><dt>Dispatches from</dt><dd>{product.store.location}</dd></div>
            </dl>
          </div>
        </div>
      </div>

      {/* More like this — ML neighbours of this product */}
      <RecommendRail similarTo={product.id} excludeSlug={product.slug} />

      {/* Reviews */}
      <section className="mt-10" aria-label="Customer reviews">
        <h2 className="text-lg font-bold">Customer reviews</h2>
        <div className="mt-4 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-3">
            {product.reviews.length === 0 ? (
              <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
                No reviews yet. Purchased this item? Share your experience below.
              </p>
            ) : (
              product.reviews.map((r) => (
                <article key={r.id} className="rounded-lg border bg-card p-4">
                  <div className="flex items-center gap-2">
                    <span className="flex" aria-label={`${r.rating} out of 5 stars`}>
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star key={i} className={`h-3.5 w-3.5 ${i < r.rating ? 'fill-primary text-primary' : 'text-muted-foreground'}`} />
                      ))}
                    </span>
                    <span className="text-sm font-medium">{r.authorName ?? 'Green Gate shopper'}</span>
                    {r.verified && <Badge variant="secondary" className="text-[10px]">Verified purchase</Badge>}
                    <span className="ml-auto text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleDateString('en-ZA')}</span>
                  </div>
                  {r.title && <p className="mt-1.5 text-sm font-medium">{r.title}</p>}
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{r.body}</p>
                </article>
              ))
            )}
          </div>

          {session && (
            <form
              className="h-fit rounded-lg border bg-card p-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (reviewText.trim().length >= 10) submitReview.mutate();
              }}
            >
              <p className="text-sm font-semibold">Write a review</p>
              <div className="mt-2 flex items-center gap-1" role="radiogroup" aria-label="Rating">
                {Array.from({ length: 5 }).map((_, i) => (
                  <button key={i} type="button" onClick={() => setReviewRating(i + 1)} aria-label={`${i + 1} stars`}>
                    <Star className={`h-5 w-5 ${i < reviewRating ? 'fill-primary text-primary' : 'text-muted-foreground'}`} />
                  </button>
                ))}
              </div>
              <Textarea
                className="mt-2 min-h-24"
                placeholder="What did you think of the product? (min 10 characters)"
                value={reviewText}
                onChange={(e) => setReviewText(e.target.value)}
                aria-label="Your review"
              />
              <Button type="submit" className="mt-3 w-full" disabled={reviewText.trim().length < 10 || submitReview.isPending}>
                {submitReview.isPending ? 'Submitting…' : 'Submit review'}
              </Button>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Purchases are verified against real orders server-side.
              </p>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
