'use client';

import { BadgeCheck, MessageCircle, ShieldCheck } from 'lucide-react';
import { navigate } from './header';

/**
 * Trust signals shared by the store and product pages. Every statement here
 * is something the marketplace really does — keep it that way.
 */

/** Shown when Green Gate has checked the seller (admin console → "Mark verified"). */
export function VerifiedSellerBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary ${className}`}
      title="Green Gate checked this seller's identity and bank details"
      data-testid="verified-seller"
    >
      <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
      Verified seller
      <span className="sr-only"> — Green Gate checked this seller&apos;s identity and bank details</span>
    </span>
  );
}

/** "1 234" — written by hand: some older browsers lack en-ZA number data. */
export function formatCount(n: number): string {
  return Math.max(0, Math.floor(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** WhatsApp's own share address: opens the app on phones and WhatsApp Web elsewhere. */
export function whatsappShareUrl(text: string, url: string): string {
  return `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;
}

export function WhatsAppShareLink({ text, url, label = 'WhatsApp', className = '' }: { text: string; url: string; label?: string; className?: string }) {
  return (
    <a
      href={whatsappShareUrl(text, url)}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary ${className}`}
      data-testid="whatsapp-share"
    >
      <MessageCircle className="h-4 w-4" aria-hidden />
      {label}
    </a>
  );
}

/** Opens the Terms at "Buyer protection" (waits for the heading, like the refund link). */
export function showBuyerProtection() {
  navigate({ name: 'terms' });
  let tries = 0;
  const step = () => {
    const el = document.getElementById('buyer-protection');
    if (el) {
      el.scrollIntoView({ block: 'start' });
      return;
    }
    if (++tries < 60) requestAnimationFrame(step);
  };
  requestAnimationFrame(() => requestAnimationFrame(step));
}

/** The short version of how buyers are protected, shown next to "Add to cart". */
export function BuyerProtectionBox({ verified }: { verified?: boolean }) {
  return (
    <section className="rounded-lg border bg-card p-3 text-xs" aria-label="Buyer protection" data-testid="buyer-protection">
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
        Buyer protection
      </p>
      <ul className="mt-2 space-y-1 text-muted-foreground">
        <li>You pay through PayFast, Ozow or Yoco — regulated payment providers. Green Gate never stores card details.</li>
        <li>Every seller is approved by Green Gate before they can sell{verified ? ', and this seller’s identity and bank details were checked' : ''}.</li>
        <li>Faulty, wrong or undelivered items: the law protects you (6 months for faulty goods, and a 7-day cooling-off for online orders).</li>
        <li>Problem with an order? Contact the seller first — if they don’t help, Green Gate steps in and can suspend sellers who break the rules.</li>
      </ul>
      <button type="button" className="mt-2 text-primary underline-offset-2 hover:underline" onClick={showBuyerProtection}>
        How buyer protection works
      </button>
    </section>
  );
}
