'use client';

import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { useConsent } from './consent';
import { navigate } from './header';

/**
 * Cookie consent banner. Shown once per browser until the visitor accepts or
 * declines optional cookies; re-openable at any time from the footer link
 * ("Cookie preferences"), which clears the stored decision.
 *
 * Formal, rectangular presentation consistent with the design system — no
 * pills, no glow, no distracting animation. Rendered above the sticky footer
 * and below dialogs (z-30).
 */
export function CookieConsent() {
  const choice = useConsent((s) => s.choice);
  const setChoice = useConsent((s) => s.setChoice);

  // Hydration-safe client detection (no effects, no setState): false on the
  // server snapshot, true once mounted — so the persisted choice never causes
  // a hydration mismatch and the banner never flashes for returning visitors.
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );

  if (!mounted || choice !== null) return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Cookie preferences"
      className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/90"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 sm:px-6 md:flex-row md:items-center md:gap-6">
        <div className="flex-1">
          <h2 className="text-sm font-semibold">Cookies</h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            Essential cookies keep the store working — your cart, your session and security. With your
            permission we also remember preferences, tailor what you see and understand how the marketplace
            is used. You can accept or decline the optional ones; your choice stays on this device. See our{' '}
            <button className="font-medium text-primary hover:underline" onClick={() => navigate({ name: 'privacy' })}>
              Privacy Policy
            </button>
            .
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setChoice('declined')}>
            Decline optional
          </Button>
          <Button size="sm" onClick={() => setChoice('accepted')}>
            Accept all
          </Button>
        </div>
      </div>
    </div>
  );
}
