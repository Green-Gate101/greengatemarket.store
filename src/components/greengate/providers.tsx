'use client';

import { useState } from 'react';
import { SessionProvider } from 'next-auth/react';
import { ThemeProvider } from 'next-themes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';

/**
 * Client providers: NextAuth session, light/dark theme (next-themes,
 * class strategy, default light = white + green) and server-state cache.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
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
