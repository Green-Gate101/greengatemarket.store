'use client';

import { useState, useSyncExternalStore } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { Search, Heart, ShoppingCart, User, Sun, Moon, Menu, X, ChevronDown, LayoutDashboard, Store, ShieldCheck, Package, LogOut } from 'lucide-react';
import { Logo } from './brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NotificationsBell } from './notifications-bell';
import { useGuestCart } from './guest-cart';

export interface Category { id: string; slug: string; name: string; parentId: string | null; children?: Category[] }

export interface Route {
  name: 'store' | 'product' | 'signin' | 'register' | 'account' | 'orders' | 'wishlist' | 'sell' | 'dashboard' | 'admin' | 'terms' | 'privacy' | 'store-page';
  slug?: string;
  q?: string;
}

export function navigate(route: Route) {
  const map: Record<Route['name'], string> = {
    store: '/', product: `/product/${route.slug ?? ''}`, signin: '/signin', register: '/register',
    account: '/account', orders: '/orders', wishlist: '/wishlist', sell: '/sell', dashboard: '/dashboard',
    admin: '/admin', terms: '/terms', privacy: '/privacy', 'store-page': `/store/${route.slug ?? ''}`,
  };
  let hash = map[route.name];
  if (route.name === 'store' && (route.slug || route.q)) {
    const params = new URLSearchParams();
    if (route.slug) params.set('category', route.slug);
    if (route.q) params.set('q', route.q);
    hash = `/?${params.toString()}`;
  }
  window.location.hash = hash;
}

const PRIMARY_NAV = ['women', 'men', 'kids', 'shoes', 'accessories', 'home-living', 'beauty', 'sports'];

// Hydration-safe "mounted" flag: server snapshot false, client snapshot true.
// React renders the server snapshot during hydration (attributes match the
// SSR HTML) and flips right after — no setState-in-effect pass needed.
const noopSubscribe = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export function Header({ route }: { route: Route }) {
  const { data: session } = useSession();
  const [search, setSearch] = useState(route.q ?? '');
  const [mobileOpen, setMobileOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  // next-themes resolves the theme from localStorage on the client only — the
  // server render must stay theme-independent or hydration attributes mismatch
  // (the sun/moon icons are CSS-switched and are safe).
  const themeMounted = useSyncExternalStore(noopSubscribe, getMountedSnapshot, getMountedServerSnapshot);
  const isDark = themeMounted && theme === 'dark';

  const { data: cartData } = useQuery({
    queryKey: ['cart', session ? 'server' : 'guest'],
    queryFn: async () => {
      if (session) {
        const res = await fetch('/api/cart');
        if (!res.ok) return { lines: [] };
        const data = await res.json();
        return { lines: (data.lines ?? []) as unknown[] };
      }
      return { lines: useGuestCart.getState().lines as unknown[] };
    },
  });

  const { data: cats } = useQuery<{ categories: Category[] }>({
    queryKey: ['categories'],
    queryFn: async () => {
      const res = await fetch('/api/categories');
      const data = await res.json();
      return data;
    },
    staleTime: 5 * 60_000,
  });

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setMobileOpen(false);
    navigate({ name: 'store', q: search.trim() });
  };

  const goCategory = (slug: string) => {
    setMobileOpen(false);
    navigate({ name: 'store', slug });
  };

  return (
    <header className="sticky top-0 z-40 border-b bg-background">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
        <button
          className="rounded-md p-1.5 hover:bg-accent md:hidden"
          onClick={() => setMobileOpen((o) => !o)}
          aria-expanded={mobileOpen}
          aria-label="Toggle navigation menu"
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>

        <Logo onClick={() => navigate({ name: 'store' })} />

        <form onSubmit={submitSearch} className="ml-2 hidden flex-1 justify-center sm:flex" role="search">
          <div className="relative w-full max-w-xl">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search products, brands and stores…"
              className="h-10 pr-10"
              aria-label="Search products"
            />
            <Button type="submit" variant="ghost" size="icon" className="absolute right-0 top-0 h-10 w-10" aria-label="Search">
              <Search className="h-4 w-4" />
            </Button>
          </div>
        </form>

        <div className="ml-auto flex items-center gap-1">
          <NotificationsBell />

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            title={isDark ? 'Light mode' : 'Dark mode'}
          >
            <Sun className="h-[18px] w-[18px] dark:hidden" />
            <Moon className="hidden h-[18px] w-[18px] dark:block" />
          </Button>

          <Button variant="ghost" size="icon" onClick={() => navigate({ name: 'wishlist' })} aria-label="Wishlist" className="hidden sm:inline-flex">
            <Heart className="h-[18px] w-[18px]" />
          </Button>

          {/* Profile is reachable in one tap on every screen size — buyers
              should never hunt for their account. */}
          <Button variant="ghost" size="icon" onClick={() => navigate({ name: 'account' })} aria-label="Account">
            <User className="h-[18px] w-[18px]" />
          </Button>

          <Button variant="ghost" size="icon" onClick={() => navigate({ name: 'account' })} aria-label="Cart" className="relative">
            <ShoppingCart className="h-[18px] w-[18px]" />
            {(cartData?.lines.length ?? 0) > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-sm bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                {cartData?.lines.length}
              </span>
            )}
          </Button>

          {session ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="ml-1 hidden sm:inline-flex">
                  {session.user?.name?.split(' ')[0] ?? 'Account'} <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <AccountMenu />
            </DropdownMenu>
          ) : (
            <Button size="sm" className="ml-1 hidden sm:inline-flex" onClick={() => navigate({ name: 'signin' })}>
              Sign in
            </Button>
          )}
        </div>
      </div>

      {/* Mobile search — search stays front-and-centre on phones, the way
          big marketplace apps show it (it was previously tucked inside the
          hamburger menu, which read as if search had been removed). */}
      <form onSubmit={submitSearch} className="border-t px-4 py-2 sm:hidden" role="search">
        <div className="relative">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search products, brands and stores…"
            className="h-10 pr-10"
            aria-label="Search products"
          />
          <Button type="submit" variant="ghost" size="icon" className="absolute right-0 top-0 h-10 w-10" aria-label="Search">
            <Search className="h-4 w-4" />
          </Button>
        </div>
      </form>

      {/* Category nav (desktop) */}
      <nav className="hidden border-t md:block" aria-label="Product categories">
        <div className="mx-auto flex h-10 max-w-7xl items-center gap-5 px-6 text-sm">
          <button className={`hover:text-primary ${!route.slug && route.name === 'store' ? 'font-semibold text-primary' : 'text-muted-foreground'}`} onClick={() => navigate({ name: 'store' })}>
            All
          </button>
          {PRIMARY_NAV.map((slug) => {
            const cat = cats?.categories.find((c) => c.slug === slug);
            return (
              <button
                key={slug}
                className={`hover:text-primary ${route.slug === slug ? 'font-semibold text-primary' : 'text-muted-foreground'}`}
                onClick={() => goCategory(slug)}
              >
                {cat?.name ?? slug}
              </button>
            );
          })}
          <DropdownMenu>
            <DropdownMenuTrigger className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-primary">
              More <ChevronDown className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(cats?.categories ?? [])
                .filter((c) => !PRIMARY_NAV.includes(c.slug))
                .map((c) => (
                  <DropdownMenuItem key={c.slug} onClick={() => goCategory(c.slug)}>
                    {c.name}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <button className="font-medium text-primary hover:underline" onClick={() => navigate({ name: 'sell' })}>
            <Store className="mr-1 inline h-4 w-4" /> Sell on Green Gate
          </button>
        </div>
      </nav>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="border-t bg-background px-4 py-3 md:hidden">
          <div className="grid grid-cols-2 gap-1 text-sm">
            <button className="rounded-md px-3 py-2 text-left hover:bg-accent" onClick={() => navigate({ name: 'store' })}>All products</button>
            {(cats?.categories ?? []).map((c) => (
              <button key={c.slug} className="rounded-md px-3 py-2 text-left hover:bg-accent" onClick={() => goCategory(c.slug)}>
                {c.name}
              </button>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1 border-t pt-2 text-sm">
            <button className="rounded-md px-3 py-2 text-left hover:bg-accent" onClick={() => { setMobileOpen(false); navigate({ name: 'sell' }); }}>Sell on Green Gate</button>
            <button className="rounded-md px-3 py-2 text-left hover:bg-accent" onClick={() => { setMobileOpen(false); navigate({ name: 'wishlist' }); }}>Wishlist</button>
            {session ? (
              <>
                <button className="rounded-md px-3 py-2 text-left hover:bg-accent" onClick={() => { setMobileOpen(false); navigate({ name: 'account' }); }}>My account</button>
                <button className="rounded-md px-3 py-2 text-left hover:bg-accent" onClick={() => void signOut()}>Sign out</button>
              </>
            ) : (
              <button className="rounded-md px-3 py-2 text-left font-medium text-primary hover:bg-accent" onClick={() => { setMobileOpen(false); navigate({ name: 'signin' }); }}>Sign in</button>
            )}
          </div>
        </div>
      )}
    </header>
  );
}

function AccountMenu() {
  const { data: session } = useSession();
  const { data: profile } = useQuery<{ user: { role: string } | null }>({
    queryKey: ['profile'],
    queryFn: async () => {
      const res = await fetch('/api/auth/me');
      return res.json();
    },
  });
  const role = profile?.user?.role ?? 'BUYER';

  return (
    <DropdownMenuContent align="end" className="w-52">
      <DropdownMenuLabel className="truncate">{session?.user?.email}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => navigate({ name: 'account' })}>
        <User className="h-4 w-4" /> My profile
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => navigate({ name: 'orders' })}>
        <Package className="h-4 w-4" /> My orders
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => navigate({ name: 'wishlist' })}>
        <Heart className="h-4 w-4" /> Wishlist
      </DropdownMenuItem>
      {(role === 'SELLER' || role === 'ADMIN') && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate({ name: 'sell' })}>
            <Store className="h-4 w-4" /> My store
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate({ name: 'dashboard' })}>
            <LayoutDashboard className="h-4 w-4" /> Seller dashboard
          </DropdownMenuItem>
        </>
      )}
      {role === 'ADMIN' && (
        <DropdownMenuItem onClick={() => navigate({ name: 'admin' })}>
          <ShieldCheck className="h-4 w-4" /> Admin console
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => void signOut()}>
        <LogOut className="h-4 w-4" /> Sign out
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
