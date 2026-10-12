'use client';

import Link from 'next/link';
import { Logo } from './brand';
import { navigate } from './header';
import { useConsent } from './consent';

/** Footer link that re-opens the cookie banner (clears the stored decision). */
function CookiePreferencesLink() {
  const reopen = useConsent((s) => s.reopen);
  return (
    <button
      className="hover:text-foreground"
      onClick={() => {
        reopen();
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      }}
    >
      Cookie preferences
    </button>
  );
}

export function Footer() {
  return (
    <footer className="mt-auto border-t bg-muted/40 pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
        <div>
          <Logo onClick={() => navigate({ name: 'store' })} />
          <p className="mt-2 text-xs font-semibold uppercase tracking-widest text-primary">Soo good you wanna gate keep</p>
          <p className="mt-3 max-w-xs text-xs leading-relaxed text-muted-foreground">
            Green Gate is a multi-vendor marketplace for anything and everything,
            connecting independent South African stores with shoppers nationwide.
          </p>
        </div>

        <nav aria-label="Shop">
          <p className="text-sm font-semibold">Shop</p>
          <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
            <li><Link className="hover:text-foreground" href="#/">All products</Link></li>
            <li><Link className="hover:text-foreground" href="#/?category=women">Women</Link></li>
            <li><Link className="hover:text-foreground" href="#/?category=men">Men</Link></li>
            <li><Link className="hover:text-foreground" href="#/?category=kids">Kids</Link></li>
            <li><Link className="hover:text-foreground" href="#/?category=shoes">Shoes</Link></li>
          </ul>
        </nav>

        <nav aria-label="Sell">
          <p className="text-sm font-semibold">Sell</p>
          <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
            <li><button className="hover:text-foreground" onClick={() => navigate({ name: 'sell' })}>Sell on Green Gate</button></li>
            <li><button className="hover:text-foreground" onClick={() => navigate({ name: 'dashboard' })}>Seller dashboard</button></li>
          </ul>
        </nav>

        <nav aria-label="Support">
          <p className="text-sm font-semibold">Support</p>
          <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
            <li><a className="hover:text-foreground" href="mailto:support@greengate.co.za">Contact us</a></li>
            <li><button className="hover:text-foreground" onClick={() => navigate({ name: 'orders' })}>Track an order</button></li>
            <li><button className="hover:text-foreground" onClick={() => navigate({ name: 'terms' })}>Shipping info</button></li>
          </ul>
        </nav>

        <nav aria-label="Legal">
          <p className="text-sm font-semibold">Legal</p>
          <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
            <li><button className="hover:text-foreground" onClick={() => navigate({ name: 'terms' })}>Terms of Service</button></li>
            <li><button className="hover:text-foreground" onClick={() => navigate({ name: 'privacy' })}>Privacy Policy</button></li>
            <li><CookiePreferencesLink /></li>
          </ul>
        </nav>
      </div>
      <div className="border-t">
        <p className="mx-auto max-w-7xl px-4 py-4 text-center text-xs text-muted-foreground sm:px-6">
          © {new Date().getFullYear()} Green Gate · Soo good you wanna gate keep · Prices in South African Rand (ZAR)
        </p>
      </div>
    </footer>
  );
}
