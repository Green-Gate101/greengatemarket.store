'use client';

/**
 * Where to send a buyer after they sign in. Sign-in used to always land on
 * the home page, so a buyer who signed in from "Sign in to checkout" (or
 * whose session had ended mid-purchase) lost their place and had to find
 * their cart again. The route lives in sessionStorage: one tab, one trip.
 */
const KEY = 'gg-return-to';

/** Remember a hash route such as "#/account" (checkout) or "#/orders". */
export function rememberReturnTo(hash: string): void {
  if (!/^#\/[A-Za-z0-9/_?=&%.-]*$/.test(hash) || /^#\/(signin|register)\b/.test(hash)) return;
  try {
    window.sessionStorage.setItem(KEY, hash);
  } catch {
    // storage blocked (private mode on some browsers) — the buyer lands on home
  }
}

/** Take (and forget) the remembered route; null when there is none. */
export function takeReturnTo(): string | null {
  try {
    const hash = window.sessionStorage.getItem(KEY);
    if (!hash) return null;
    window.sessionStorage.removeItem(KEY);
    return /^#\/[A-Za-z0-9/_?=&%.-]*$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

/** Go to the remembered route, or home. The app shell may already have
 *  resumed the remembered page the moment the session appeared — then the
 *  buyer stays where they are instead of being sent home. */
export function goAfterSignIn(): void {
  const back = takeReturnTo();
  if (back) {
    window.location.hash = back;
    return;
  }
  if (!window.location.hash || /^#\/(signin|register)\b/.test(window.location.hash)) window.location.hash = '#/';
}
