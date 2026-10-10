'use client';

import { Store, LayoutDashboard, ShoppingBag, PackagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useCart } from '@/lib/cart-store';
import type { SellerDto } from '@/lib/types';

export type View = 'store' | 'sell' | 'dashboard';

export function Header({
  view,
  onViewChange,
  onOpenCart,
  seller,
}: {
  view: View;
  onViewChange: (v: View) => void;
  onOpenCart: () => void;
  seller: SellerDto | null;
}) {
  // The cart store starts empty on both server and client, so reading it
  // directly is hydration-safe.
  const lines = useCart((s) => s.lines);
  const count = lines.reduce((s, l) => s + l.quantity, 0);

  const navButton = (target: View, label: string, Icon: typeof Store) => (
    <Button
      variant={view === target ? 'default' : 'ghost'}
      size="sm"
      onClick={() => onViewChange(target)}
      aria-current={view === target ? 'page' : undefined}
      className="gap-2"
    >
      <Icon className="h-4 w-4" aria-hidden />
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
        <button
          onClick={() => onViewChange('store')}
          className="flex items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-ring"
          aria-label="Soko Market home"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Store className="h-5 w-5" aria-hidden />
          </span>
          <span className="text-lg font-semibold tracking-tight">
            Soko<span className="text-primary">Market</span>
          </span>
        </button>

        <nav className="flex items-center gap-1.5" aria-label="Main navigation">
          {navButton('store', 'Marketplace', Store)}
          {navButton('sell', 'Sell with us', PackagePlus)}
          {navButton('dashboard', 'Dashboard', LayoutDashboard)}
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenCart}
            className="relative ml-1 gap-2"
            aria-label={`Open cart, ${count} item${count === 1 ? '' : 's'}`}
          >
            <ShoppingBag className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">Cart</span>
            {count > 0 && (
              <Badge className="h-5 min-w-5 rounded-full px-1 text-[11px] tabular-nums" aria-hidden>
                {count}
              </Badge>
            )}
          </Button>
        </nav>
      </div>
      {view !== 'store' && (
        <div className="border-t bg-muted/40">
          <p className="mx-auto max-w-7xl px-4 py-1.5 text-xs text-muted-foreground sm:px-6">
            {view === 'sell'
              ? seller
                ? `Signed in as ${seller.storeName} · ${seller.location}`
                : 'Create your seller account to start listing products.'
              : seller
                ? `Seller dashboard for ${seller.storeName}`
                : 'Select or create a store to see its dashboard.'}
          </p>
        </div>
      )}
    </header>
  );
}
