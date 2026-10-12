import { Suspense } from 'react';
import { AppShell } from '@/components/greengate/app-shell';
import { GateMark } from '@/components/greengate/brand';

/**
 * Branded launch screen: the moment the app opens it shows the Green Gate
 * logo, name and slogan — the same instant-open feel as the big marketplace
 * apps — instead of a bare "loading" message. The fallback is only visible
 * for the brief hydration window before the shell takes over.
 */
export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background" role="status" aria-label="Green Gate is opening">
          <span className="flex h-20 w-20 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <GateMark className="h-11 w-11" />
          </span>
          <p className="text-lg font-bold tracking-[0.22em]">
            GREEN <span className="text-primary">GATE</span>
          </p>
          <p className="text-sm text-muted-foreground">Soo good you wanna gate keep</p>
        </div>
      }
    >
      <AppShell />
    </Suspense>
  );
}
