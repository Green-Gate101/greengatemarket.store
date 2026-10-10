'use client';

import { create } from 'zustand';
import type { ProductDto } from './types';

export interface CartLine {
  product: ProductDto;
  quantity: number;
}

interface CartState {
  lines: CartLine[];
  add: (product: ProductDto, quantity?: number) => void;
  remove: (productId: string) => void;
  setQuantity: (productId: string, quantity: number) => void;
  clear: () => void;
  count: () => number;
  subtotal: () => number;
}

export const useCart = create<CartState>((set, get) => ({
  lines: [],
  add: (product, quantity = 1) =>
    set((state) => {
      const existing = state.lines.find((l) => l.product.id === product.id);
      if (existing) {
        return {
          lines: state.lines.map((l) =>
            l.product.id === product.id
              ? { ...l, quantity: Math.min(l.quantity + quantity, Math.max(product.stock, 1)) }
              : l,
          ),
        };
      }
      return { lines: [...state.lines, { product, quantity: Math.min(quantity, Math.max(product.stock, 1)) }] };
    }),
  remove: (productId) => set((state) => ({ lines: state.lines.filter((l) => l.product.id !== productId) })),
  setQuantity: (productId, quantity) =>
    set((state) => ({
      lines: state.lines.map((l) =>
        l.product.id === productId
          ? { ...l, quantity: Math.max(1, Math.min(quantity, Math.max(l.product.stock, 1))) }
          : l,
      ),
    })),
  clear: () => set({ lines: [] }),
  count: () => get().lines.reduce((s, l) => s + l.quantity, 0),
  subtotal: () => get().lines.reduce((s, l) => s + l.product.price * l.quantity, 0),
}));
