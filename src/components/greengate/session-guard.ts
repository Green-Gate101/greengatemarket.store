'use client';

import { signOut } from 'next-auth/react';
import { toast } from '@/hooks/use-toast';
import { rememberReturnTo } from './return-route';

/**
 * A browser can hold a session the server no longer accepts: it expired
 * while a tab sat open for days, it was signed in before a password reset,
 * or it is incomplete. The header kept showing the buyer as signed in while
 * every purchase answered "Sign in to continue". This ends such a session
 * cleanly — once — remembers the page, and asks the buyer to sign in again.
 */
let ending = false;

export function endStaleSession(): void {
  if (ending) return;
  ending = true;
  rememberReturnTo(window.location.hash || '#/');
  void signOut({ redirect: false }).finally(() => {
    toast({ title: 'Please sign in again', description: 'Your sign-in on this device ended. Your cart is kept — you will come straight back here.' });
    window.location.hash = '#/signin';
    setTimeout(() => {
      ending = false;
    }, 5000);
  });
}

/** React Query error hook: the server's "sign in" refusals end the session. */
export function endStaleSessionOnAuthError(error: unknown): void {
  const message = error instanceof Error ? error.message : '';
  if (/^Sign in to continue|password was changed/i.test(message)) endStaleSession();
}
