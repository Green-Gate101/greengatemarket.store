'use client';

import { useEffect } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Route-level error boundary (App Router convention: src/app/error.tsx).
 *
 * Catches any uncaught client-side exception inside the page subtree and
 * renders a branded recovery card in place of the crashed view. The rest of
 * the document (header/footer live outside this tree only when they are not
 * part of the crashed subtree) is never blanked by a single bad render, and
 * users always get a way forward instead of a dead screen.
 *
 * Complements global-error.tsx, which is the last-resort boundary for errors
 * that escape this one (root layout / chunk-level failures).
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Surface the error in the console (the browser console is the one place a
  // user can always find it — keep the trail for support requests).
  useEffect(() => {
    console.error('Green Gate view error:', error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-4 px-4 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-secondary" aria-hidden>
        <ShieldAlert className="h-6 w-6 text-primary" />
      </div>
      <h1 className="text-lg font-bold">Something went wrong on this page</h1>
      <p className="text-sm text-muted-foreground">
        An unexpected error interrupted this view. Your account and data are safe — reloading usually fixes it right away.
      </p>
      {error?.digest ? (
        <p className="font-mono text-[11px] text-muted-foreground">Reference: {error.digest}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <Button onClick={() => reset()}>Try again</Button>
        <Button variant="outline" onClick={() => window.location.assign('/')}>
          Go to homepage
        </Button>
      </div>
    </main>
  );
}
