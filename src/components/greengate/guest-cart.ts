'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Guest cart (localStorage). Once signed in, the server cart (/api/cart) is
 * authoritative and guest lines are merged on login by the app shell.
 */
export interface GuestLine {
  productId: string;
  variantId: string | null;
  quantity: number;
  name: string;
  image: string | null;
  unitPriceCents: number;
  slug: string;
  storeName: string;
}

interface GuestCartState {
  lines: GuestLine[];
  add: (line: Omit<GuestLine, 'quantity'>, quantity?: number) => void;
  setQuantity: (productId: string, variantId: string | null, quantity: number) => void;
  remove: (productId: string, variantId: string | null) => void;
  clear: () => void;
}

export const useGuestCart = create<GuestCartState>()(
  persist(
    (set) => ({
      lines: [],
      add: (line, quantity = 1) =>
        set((state) => {
          const idx = state.lines.findIndex((l) => l.productId === line.productId && l.variantId === line.variantId);
          if (idx >= 0) {
            const lines = [...state.lines];
            lines[idx] = { ...lines[idx], quantity: Math.min(99, lines[idx].quantity + quantity) };
            return { lines };
          }
          return { lines: [...state.lines, { ...line, quantity }] };
        }),
      setQuantity: (productId, variantId, quantity) =>
        set((state) => ({
          lines:
            quantity <= 0
              ? state.lines.filter((l) => !(l.productId === productId && l.variantId === variantId))
              : state.lines.map((l) => (l.productId === productId && l.variantId === variantId ? { ...l, quantity: Math.min(99, quantity) } : l)),
        })),
      remove: (productId, variantId) =>
        set((state) => ({ lines: state.lines.filter((l) => !(l.productId === productId && l.variantId === variantId)) })),
      clear: () => set({ lines: [] }),
    }),
    { name: 'greengate-cart' },
  ),
);

/**
 * Stable anonymous profile id used by the recommendation engine. Generated
 * once per browser and kept in localStorage — pre-signup browsing history is
 * preserved and merged into the account on sign-in.
 */
export function getGuestId(): string {
  const KEY = 'greengate-guest-id';
  try {
    let id = window.localStorage.getItem(KEY);
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = `g-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      window.localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return 'g-anonymous-browser';
  }
}

/** Synchronised in-flight guard — set/cleared synchronously around the merge. */
let mergeInFlight = false;

/**
 * Merge the guest cart into the signed-in server cart — EXACTLY ONCE.
 *
 * Returns true when this call claimed guest lines and posted them (so the
 * caller can refresh the cart UI), false when there was nothing to merge or
 * another merge is already running.
 *
 * Why this must be the ONLY merge path: two call sites used to merge
 * independently (the auth view after sign-in and the app-shell session
 * effect), and the session effect re-fires whenever NextAuth refreshes the
 * session object. Each run posted the SAME guest lines, and POST /api/cart
 * increments the quantity of an existing line — so a buyer who added ONE item
 * as a guest could land on 2×, 3× or 4× it after signing in and pay for every
 * copy at checkout. The claim below happens SYNCHRONOUSLY (capture + clear +
 * in-flight guard before the first await), so no matter how many callers
 * race — same tick or a later session refetch — exactly one merge runs per
 * set of guest lines. A post that fails hands its line back to the guest cart
 * instead of silently losing the buyer's item.
 */
export async function mergeGuestCartIntoServer(): Promise<boolean> {
  if (mergeInFlight) return false;
  const guest = useGuestCart.getState().lines;
  if (guest.length === 0) return false;
  mergeInFlight = true;
  useGuestCart.getState().clear(); // claim immediately — concurrent callers now see an empty cart
  try {
    for (const line of guest) {
      const res = await fetch('/api/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: line.productId, variantId: line.variantId, quantity: line.quantity }),
      }).catch(() => undefined);
      if (!res || !res.ok) {
        // Restore so the item survives for the next successful merge.
        useGuestCart.getState().add(line, line.quantity);
      }
    }
  } finally {
    mergeInFlight = false;
  }
  return true;
}

/** Remove the guest profile id after a successful server-side merge. */
export function clearGuestId(): void {
  try {
    window.localStorage.removeItem('greengate-guest-id');
  } catch {
    // storage unavailable — nothing to clear
  }
}
