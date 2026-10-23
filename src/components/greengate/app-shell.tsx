'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useQueryClient } from '@tanstack/react-query';
import { Header, navigate, type Route } from './header';
import { Footer } from './footer';
import { Storefront } from './storefront';
import { ProductView } from './product-view';
import { AuthView } from './auth-view';
import { AccountView } from './account-view';
import { SellView } from './sell-view';
import { DashboardView } from './dashboard-view';
import { AdminView } from './admin-view';
import { LegalView } from './legal-view';
import { StoreView } from './store-view';
import { CartSheet } from './cart-sheet';
import { CookieConsent, ConsentBottomSpacer } from './cookie-consent';
import { mergeGuestCartIntoServer, getGuestId, clearGuestId } from './guest-cart';
import { hasOptionalConsent } from './consent';
import { useToast } from '@/hooks/use-toast';

/** External store: the URL hash (deep-linkable SPA routing). */
function subscribeHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

/**
 * Application shell. The marketplace renders as a single-page app whose view
 * is derived from the URL hash via useSyncExternalStore, so every screen is
 * deep-linkable (e.g. #/product/<slug>, #/dashboard) while remaining one
 * fast bundle — with no state/effects for routing at all.
 */
export function AppShell() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash, () => '');
  const [cartOpen, setCartOpen] = useState(false);
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const hashRoute = useMemo(() => parseHash(hash), [hash]);

  // Real query params (e.g. /?category=women from the footer) refine the store view.
  const initialCategory = searchParams.get('category');
  const initialQuery = searchParams.get('q');
  const effectiveRoute: Route =
    hashRoute.name === 'store' && !hashRoute.slug && !hashRoute.q && (initialCategory || initialQuery)
      ? { name: 'store', slug: initialCategory ?? undefined, q: initialQuery ?? undefined }
      : hashRoute;

  // Scroll to top whenever the route changes (external-system side effect).
  const routeKey = `${effectiveRoute.name}:${effectiveRoute.slug ?? ''}:${effectiveRoute.q ?? ''}`;
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [routeKey]);

  // Merge the guest cart into the server cart when the user signs in — the
  // shared helper claims the lines synchronously so repeated session updates
  // can never post them twice (quantities used to multiply on sign-in).
  useEffect(() => {
    if (!session) return;
    void mergeGuestCartIntoServer().then((result) => {
      if (result.merged) queryClient.invalidateQueries({ queryKey: ['cart'] });
      // Tell the buyer when a guest line was dropped as permanently
      // unavailable — items must never vanish without a word.
      if (result.unavailable.length > 0) {
        toast({ title: 'Some items are no longer available', description: `${result.unavailable.join(', ')} ${result.unavailable.length > 1 ? 'were' : 'was'} removed from your cart.` });
      }
    });
  }, [session, queryClient, toast]);

  // Merge the anonymous recommendation-learning profile into the account once
  // per sign-in, so pre-signup browsing keeps shaping recommendations — only
  // when the visitor accepted optional cookies.
  useEffect(() => {
    if (!session) return;
    if (!hasOptionalConsent()) return;
    const guestId = getGuestId();
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/recommendations/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ guestId }),
        });
        if (res.ok && !cancelled) clearGuestId();
      } catch {
        // offline / transient — the profile stays and merges next sign-in
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Feedback flags from the email-verification redirect.
  const verifyFlag = searchParams.get('verify');

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground">
        Skip to content
      </a>
      <Header route={effectiveRoute} />
      <div id="main-content" className="flex w-full flex-1 flex-col">
        {effectiveRoute.name === 'store' && <Storefront key={`${effectiveRoute.slug ?? ''}-${effectiveRoute.q ?? ''}`} route={effectiveRoute} />}
        {/* key remounts the view per product — reusing the instance carried
            stale variant/image state from the previously viewed product, so
            Add to Cart submitted a foreign variantId and failed. */}
        {effectiveRoute.name === 'product' && <ProductView key={effectiveRoute.slug ?? ''} slug={effectiveRoute.slug ?? ''} />}
        {effectiveRoute.name === 'signin' && <AuthView key="signin" initialMode="signin" />}
        {effectiveRoute.name === 'register' && <AuthView key="register" initialMode="register" />}
        {effectiveRoute.name === 'account' && <AccountView initialTab="checkout" />}
        {effectiveRoute.name === 'orders' && <AccountView initialTab="orders" />}
        {effectiveRoute.name === 'wishlist' && <AccountView initialTab="wishlist" />}
        {effectiveRoute.name === 'sell' && <SellView />}
        {effectiveRoute.name === 'dashboard' && <DashboardView />}
        {effectiveRoute.name === 'admin' && <AdminView />}
        {effectiveRoute.name === 'terms' && <LegalView doc="terms" />}
        {effectiveRoute.name === 'privacy' && <LegalView doc="privacy" />}
        {effectiveRoute.name === 'store-page' && <StoreView slug={effectiveRoute.slug ?? ''} />}
      </div>
      {/* Reserves the cookie banner's height while it is undecided, so the
          fixed banner can never cover bottom-of-page CTAs (it obscured the
          checkout "Place order" button — taps hit the banner, not the app). */}
      <ConsentBottomSpacer />
      <Footer />

      <CartSheet open={cartOpen} onOpenChange={setCartOpen} />

      <CookieConsent />

      {verifyFlag && (
        <VerifyBanner flag={verifyFlag} onDismiss={() => navigate({ name: 'store' })} />
      )}
    </div>
  );
}

function VerifyBanner({ flag, onDismiss }: { flag: string; onDismiss: () => void }) {
  const ok = flag === 'ok';
  return (
    <div className="fixed inset-x-0 top-16 z-50 mx-auto w-fit max-w-[90vw] rounded-md border bg-card px-4 py-3 text-sm shadow-lg" role="status">
      {ok ? '✅ Email verified — you can now use every account feature.' : '⚠️ That verification link is invalid or has expired. Request a new one from your profile.'}
      <button className="ml-3 font-medium text-primary hover:underline" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '');
  const [path, query] = clean.split('?');
  const parts = (path ?? '').split('/').filter(Boolean);
  const params = new URLSearchParams(query ?? '');

  switch (parts[0]) {
    case undefined:
    case '':
      return { name: 'store', slug: params.get('category') ?? undefined, q: params.get('q') ?? undefined };
    case 'product':
      return { name: 'product', slug: parts[1] };
    case 'signin':
      return { name: 'signin' };
    case 'register':
      return { name: 'register' };
    case 'account':
      return { name: 'account' };
    case 'orders':
      return { name: 'orders' };
    case 'wishlist':
      return { name: 'wishlist' };
    case 'sell':
      return { name: 'sell' };
    case 'dashboard':
      return { name: 'dashboard' };
    case 'admin':
      return { name: 'admin' };
    case 'terms':
      return { name: 'terms' };
    case 'privacy':
      return { name: 'privacy' };
    case 'store':
      return { name: 'store-page', slug: parts[1] };
    default:
      return { name: 'store' };
  }
}
