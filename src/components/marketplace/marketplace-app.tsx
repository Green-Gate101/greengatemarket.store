'use client';

import { useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { Header, type View } from './header';
import { Storefront } from './storefront';
import { SellView } from './sell-view';
import { DashboardView } from './dashboard-view';
import { CartSheet } from './cart-sheet';
import { ProductDialog } from './product-dialog';
import { useToast } from '@/hooks/use-toast';
import { useCart } from '@/lib/cart-store';
import type { ProductDto, SellerDto } from '@/lib/types';
import { ShoppingBag, Store, MapPin, ShieldCheck } from 'lucide-react';

const SELLER_KEY = 'soko_seller_email';

async function fetchSellers(): Promise<SellerDto[]> {
  const res = await fetch('/api/sellers');
  if (!res.ok) throw new Error('Failed to load sellers');
  const data = await res.json();
  return data.sellers ?? [];
}

function Marketplace() {
  const [view, setView] = useState<View>('store');
  const [cartOpen, setCartOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ProductDto | null>(null);
  const [selectedSellerEmail, setSelectedSellerEmail] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const add = useCart((s) => s.add);

  const { data: sellers = [] } = useQuery({
    queryKey: ['sellers'],
    queryFn: fetchSellers,
    staleTime: 15_000,
  });

  // Seller identity is keyed on the store email (stable across server
  // reseeds) rather than the database id.
  const seller = useMemo(() => {
    const email = selectedSellerEmail ?? (typeof window !== 'undefined' ? localStorage.getItem(SELLER_KEY) : null);
    if (!email) return null;
    return sellers.find((s) => s.email === email) ?? null;
  }, [sellers, selectedSellerEmail]);

  const selectSeller = (s: SellerDto) => {
    setSelectedSellerEmail(s.email);
    localStorage.setItem(SELLER_KEY, s.email);
  };

  const handleSellerCreated = (s: SellerDto) => {
    setSelectedSellerEmail(s.email);
    localStorage.setItem(SELLER_KEY, s.email);
    queryClient.invalidateQueries({ queryKey: ['sellers'] });
    toast({
      title: `${s.storeName} is live!`,
      description: 'Upload your first product below — photos get a white background automatically.',
    });
    setView('sell');
  };

  const handleAddToCart = (p: ProductDto) => {
    add(p, 1);
    toast({
      title: 'Added to cart',
      description: `${p.name} × 1 — ${p.seller?.storeName ?? 'Soko Market'}`,
    });
  };

  return (
    <div className="flex min-h-screen flex-col">
      <Header view={view} onViewChange={setView} onOpenCart={() => setCartOpen(true)} seller={seller} />

      {view === 'store' && (
        <Storefront
          onOpenProduct={(p) => setSelectedProduct(p)}
          onAddToCart={handleAddToCart}
        />
      )}
      {view === 'sell' && (
        <SellView
          seller={seller}
          sellers={sellers}
          onSellerCreated={handleSellerCreated}
          onSelectSeller={selectSeller}
          onGoToDashboard={() => setView('dashboard')}
        />
      )}
      {view === 'dashboard' && (
        <DashboardView
          seller={seller}
          sellers={sellers}
          onSelectSeller={selectSeller}
          onGoToSell={() => setView('sell')}
        />
      )}

      <footer className="mt-auto border-t bg-muted/30 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:grid-cols-3 sm:px-6">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Store className="h-4 w-4" aria-hidden />
              </span>
              Soko<span className="text-primary">Market</span>
            </p>
            <p className="mt-2 max-w-xs text-xs leading-relaxed text-muted-foreground">
              A multi-vendor marketplace connecting South African sellers with buyers nationwide.
            </p>
          </div>
          <nav aria-label="Marketplace links">
            <p className="text-sm font-medium">Marketplace</p>
            <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
              <li><button className="hover:text-foreground" onClick={() => setView('store')}>Browse products</button></li>
              <li><button className="hover:text-foreground" onClick={() => setView('sell')}>Become a seller</button></li>
              <li><button className="hover:text-foreground" onClick={() => setView('dashboard')}>Seller dashboard</button></li>
            </ul>
          </nav>
          <div>
            <p className="text-sm font-medium">Why Soko</p>
            <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
              <li className="flex items-center gap-1.5">
                <ShoppingBag className="h-3 w-3" aria-hidden /> Auto white-background product photos
              </li>
              <li className="flex items-center gap-1.5">
                <MapPin className="h-3 w-3" aria-hidden /> Nationwide courier delivery
              </li>
              <li className="flex items-center gap-1.5">
                <ShieldCheck className="h-3 w-3" aria-hidden /> Email receipts on every order
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t">
          <p className="mx-auto max-w-7xl px-4 py-4 text-center text-xs text-muted-foreground sm:px-6">
            © {new Date().getFullYear()} Soko Market · Prices in South African Rand (ZAR)
          </p>
        </div>
      </footer>

      <CartSheet open={cartOpen} onOpenChange={setCartOpen} />
      <ProductDialog
        product={selectedProduct}
        open={selectedProduct !== null}
        onOpenChange={(o) => { if (!o) setSelectedProduct(null); }}
        onAdded={() => {
          if (selectedProduct) {
            const line = useCart.getState().lines.find((l) => l.product.id === selectedProduct.id);
            toast({
              title: 'Added to cart',
              description: `${selectedProduct.name} × ${line?.quantity ?? 1} — ${selectedProduct.seller?.storeName ?? 'Soko Market'}`,
            });
          }
        }}
      />
    </div>
  );
}

export function MarketplaceApp() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <Marketplace />
    </QueryClientProvider>
  );
}
