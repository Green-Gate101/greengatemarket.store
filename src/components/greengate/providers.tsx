'use client';

import { useState } from 'react';
import { SessionProvider } from 'next-auth/react';
import { ThemeProvider } from 'next-themes';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { endStaleSessionOnAuthError } from './session-guard';
import { Toaster } from '@/components/ui/toaster';

/**
 * Client providers: NextAuth session, light/dark theme (next-themes,
 * class strategy, default light = white + green) and server-state cache.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // An action refused with "Sign in to continue" means this browser's
        // session ended — sign out cleanly instead of leaving the buyer
        // looking signed in.
        queryCache: new QueryCache({ onError: endStaleSessionOnAuthError }),
        mutationCache: new MutationCache({ onError: endStaleSessionOnAuthError }),
        defaultOptions: {
          queries: {
            // Two quick retries with short back-off: a cold serverless
            // instance occasionally answers its very first request slowly or
            // with a transient 500 — the query self-heals instead of showing
            // an error card that reads as "the app failed to load".
            retry: 2,
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
            refetchOnWindowFocus: false,
            staleTime: 10_000,
            // Always try the network, never trust navigator.onLine to hold a
            // request back. The default ('online') PAUSED loads while offline,
            // and paused loads fell through to empty states ("No products
            // found", "Store not found") — and on devices whose WebView wrongly
            // reports offline, nothing would ever load. Now a real outage shows
            // the honest "could not load — Try again" state (plus the offline
            // notice), and loads refetch by themselves on reconnect.
            networkMode: 'always',
          },
          mutations: {
            // Same for actions: a paused "Place order" sat on "Placing order…"
            // with no word; a real outage now reports the failure honestly.
            networkMode: 'always',
          },
        },
      }),
  );

  return (
    <SessionProvider>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
        <QueryClientProvider client={queryClient}>
          {children}
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
