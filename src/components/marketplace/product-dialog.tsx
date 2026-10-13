'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ProductImage } from './product-image';
import { StockPill, WhiteBgNote } from './product-card';
import { formatZAR } from '@/lib/format';
import { useCart } from '@/lib/cart-store';
import type { ProductDto } from '@/lib/types';
import { Minus, Plus, ShoppingBag, MapPin } from 'lucide-react';

export function ProductDialog({
  product,
  open,
  onOpenChange,
  onAdded,
}: {
  product: ProductDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [quantity, setQuantity] = useState(1);
  const add = useCart((s) => s.add);
  const out = product ? product.stock <= 0 : false;

  const handleAdd = () => {
    if (!product || out) return;
    add(product, quantity);
    onAdded();
    onOpenChange(false);
    setQuantity(1);
  };

  if (!product) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setQuantity(1); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" aria-describedby={undefined}>
        <DialogHeader className="sr-only">
          <DialogTitle>{product.name}</DialogTitle>
          <DialogDescription>Product details</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="rounded-lg border bg-white p-4">
            <ProductImage
              src={product.imageData}
              alt={product.name}
              className="aspect-square w-full rounded-md object-contain"
            />
            <div className="mt-3">
              <WhiteBgNote />
            </div>
          </div>
          <div className="flex flex-col">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {product.seller?.storeName}
            </p>
            <h2 className="mt-1 text-xl font-semibold leading-tight">{product.name}</h2>
            <div className="mt-2 flex items-center gap-2">
              <StockPill stock={product.stock} />
              <Badge variant="outline">{product.category}</Badge>
            </div>
            {product.seller?.location && (
              <p className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                <MapPin className="h-3.5 w-3.5" aria-hidden /> Ships from {product.seller.location}
              </p>
            )}
            <Separator className="my-4" />
            <p className="text-sm leading-relaxed text-muted-foreground">{product.description}</p>
            <div className="mt-auto pt-5">
              <p className="text-2xl font-semibold tabular-nums">{formatZAR(product.price)}</p>
              <div className="mt-3 flex items-center gap-3">
                <div className="flex items-center rounded-md border" role="group" aria-label="Quantity">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                    disabled={quantity <= 1 || out}
                    aria-label="Decrease quantity"
                  >
                    <Minus className="h-4 w-4" aria-hidden />
                  </Button>
                  <span className="w-8 text-center text-sm font-medium tabular-nums" aria-live="polite">
                    {quantity}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => setQuantity((q) => Math.min(product.stock || 1, q + 1))}
                    disabled={out || quantity >= product.stock}
                    aria-label="Increase quantity"
                  >
                    <Plus className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
                <Button className="flex-1 gap-2" onClick={handleAdd} disabled={out}>
                  <ShoppingBag className="h-4 w-4" aria-hidden />
                  {out ? 'Sold out' : 'Add to cart'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
