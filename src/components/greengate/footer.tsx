'use client';

import Link from 'next/link';
import { ShieldCheck, Truck, MailOpen, Camera } from 'lucide-react';
import { Logo } from './brand';
import { navigate } from './header';

export function Footer() {
  return (
    <footer className="mt-auto border-t bg-muted/40 pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
        <div>
          <Logo onClick={() => navigate({ name: 'store' })} />
          <p className="mt-3 max-w-xs text-xs leading-relaxed text-muted-foreground">
            Green Gate is a multi-vendor marketplace for fashion, lifestyle and general merchandise.
            Real sellers, genuine product photos and nationwide courier delivery.
          </p>
          <ul className="mt-4 space-y-1.5 text-xs text-muted-foreground">
            <li className="flex items-center gap-1.5"><Camera className="h-3.5 w-3.5" aria-hidden /> Verified real product photos — AI images banned</li>
            <li className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Secure accounts and audited orders</li>
            <li className="flex items-center gap-1.5"><Truck className="h-3.5 w-3.5" aria-hidden /> Courier delivery with tracking</li>
            <li className="flex items-center gap-1.5"><MailOpen className="h-3.5 w-3.5" aria-hidden /> Email updates on every order</li>
          </ul>
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
          </ul>
        </nav>
      </div>
      <div className="border-t">
        <p className="mx-auto max-w-7xl px-4 py-4 text-center text-xs text-muted-foreground sm:px-6">
          © {new Date().getFullYear()} Green Gate · Prices in South African Rand (ZAR)
        </p>
      </div>
    </footer>
  );
}
