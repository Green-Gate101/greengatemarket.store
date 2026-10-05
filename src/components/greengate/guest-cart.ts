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
