'use client';

import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { AppShell } from './app-shell';

/**
 * Entry point for the crawlable landing URLs (/product/<slug>, /store/<slug>).
 *
 * The server renders `children` — a lightweight preview of the listing that
 * crawlers and no-JS link-preview bots read. In the browser the regular
 * hash-routed SPA then takes over on the SAME view: a bare landing URL gets
 * the matching hash (`#/product/<slug>`), while an explicit hash (an older
 * shared deep link) always wins. Everything after that is the unchanged app.
 */
export function SpaLanding({ hash, children }: { hash: string; children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!window.location.hash || window.location.hash === '#') {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash}`);
    }
    setReady(true);
  }, [hash]);

  if (!ready) return <>{children}</>;
  return (
    <Suspense fallback={children}>
      <AppShell />
    </Suspense>
  );
}
