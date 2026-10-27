/**
 * Pickup-point delivery a seller can offer next to door delivery:
 *  - PAXI — the buyer collects at a PAXI point (PEP stores);
 *  - Pudo — the buyer collects from a The Courier Guy (Pudo) locker.
 *
 * The seller sets the price buyers pay and the delivery time they book with
 * the provider, then sends the parcel to the point the buyer chose. Green
 * Gate shows that price, charges it at checkout and tells the seller where
 * to send it. Prices change: the suggestions below are the providers'
 * published prices when this was written (October 2026), never charged on
 * their own — a seller always confirms their own price.
 */

export type PickupKind = 'paxi' | 'pudo';

export const PICKUP_KINDS: PickupKind[] = ['paxi', 'pudo'];

export const PICKUP_ETAS = ['1-3', '2-4', '3-5', '5-7', '7-9'] as const;

export const PICKUP_INFO: Record<PickupKind, {
  label: string; // the delivery option as buyers see it
  point: string; // what the buyer picks
  finderUrl: string; // the provider's own map of points
  finderLabel: string;
  suggestedCents: number;
  suggestedEta: (typeof PICKUP_ETAS)[number];
  suggestionNote: string;
}> = {
  paxi: {
    label: 'Collect at a PAXI point (PEP store)',
    point: 'PAXI point',
    finderUrl: 'https://www.paxi.co.za/paxi-points',
    finderLabel: 'Find a PAXI point on paxi.co.za',
    suggestedCents: 5995,
    suggestedEta: '7-9',
    suggestionNote: 'PAXI standard bag (up to 5 kg), 7–9 business days: R59.95 on paxi.co.za in October 2026.',
  },
  pudo: {
    label: 'Collect from a Pudo locker',
    point: 'Pudo locker',
    finderUrl: 'https://thecourierguy.co.za/locker-courier-services/',
    finderLabel: 'Find a Pudo locker on thecourierguy.co.za',
    suggestedCents: 5900,
    suggestedEta: '2-4',
    suggestionNote: 'Pudo extra-small locker-to-locker (up to 2 kg): from about R59 in October 2026 — check The Courier Guy for your parcel size.',
  },
};

/** "7-9" → "7–9 business days". */
export function etaLabel(eta: string | null | undefined): string {
  return eta && /^\d{1,2}-\d{1,2}$/.test(eta) ? `${eta.replace('-', '–')} business days` : 'business days set by the seller';
}

export interface StorePickupFields {
  pickupPaxiCents: number | null;
  pickupPaxiEta: string | null;
  pickupPudoCents: number | null;
  pickupPudoEta: string | null;
}

/** What a store offers, as buyers see it (null = not offered). */
export function publicPickup(s: StorePickupFields): Record<PickupKind, { priceCents: number; eta: string } | null> {
  return {
    paxi: s.pickupPaxiCents != null && s.pickupPaxiCents > 0 ? { priceCents: s.pickupPaxiCents, eta: etaLabel(s.pickupPaxiEta) } : null,
    pudo: s.pickupPudoCents != null && s.pickupPudoCents > 0 ? { priceCents: s.pickupPudoCents, eta: etaLabel(s.pickupPudoEta) } : null,
  };
}

/** The store's price for a pickup kind, or null when it does not offer it. */
export function pickupPriceCents(s: StorePickupFields, kind: PickupKind): number | null {
  const v = kind === 'paxi' ? s.pickupPaxiCents : s.pickupPudoCents;
  return v != null && v > 0 ? v : null;
}

/** Highest pickup price a seller may set (R1 000) — a typo guard, not a provider rule. */
export const PICKUP_MAX_CENTS = 100_000;
