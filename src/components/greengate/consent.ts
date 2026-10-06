'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Cookie consent (POPIA/GDPR-style choice):
 *
 * - `accepted`  → essential + optional cookies (cart, recommendations
 *   personalisation, usage feedback) may be used.
 * - `declined`  → strictly-necessary storage only (cart contents, session,
 *   security). Optional personalisation signals are not recorded and the
 *   anonymous learning profile is neither created nor merged.
 *
 * The choice lives in localStorage on the user's device (it is itself an
 * essential preference) and is never sent anywhere. Visitors can revisit the
 * decision at any time via "Cookie preferences" in the footer.
 */

export type ConsentChoice = 'accepted' | 'declined';

interface ConsentState {
  choice: ConsentChoice | null;
  decidedAt: string | null;
  setChoice: (choice: ConsentChoice) => void;
  /** Clear the decision so the banner is offered again. */
  reopen: () => void;
}

export const useConsent = create<ConsentState>()(
  persist(
    (set) => ({
      choice: null,
      decidedAt: null,
      setChoice: (choice) => set({ choice, decidedAt: new Date().toISOString() }),
      reopen: () => set({ choice: null, decidedAt: null }),
    }),
    { name: 'greengate-cookie-consent' },
  ),
);

/** True only when the visitor explicitly accepted optional cookies. */
export function hasOptionalConsent(): boolean {
  return useConsent.getState().choice === 'accepted';
}
