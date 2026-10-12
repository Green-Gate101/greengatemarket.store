import Link from 'next/link';
import { GateMark } from '@/components/greengate/brand';

/**
 * Branded 404: any mistyped or stale link lands on a Green Gate page — never
 * a bare framework error screen. The marketplace itself is a single-page app
 * at "#/…" routes, so this only shows for genuinely unknown paths.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
        <GateMark className="h-9 w-9" />
      </span>
      <p className="text-lg font-bold tracking-[0.22em]">
        GREEN <span className="text-primary">GATE</span>
      </p>
      <h1 className="text-xl font-semibold">This page doesn&apos;t exist</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        The link may be old or mistyped. Everything you need is on the marketplace.
      </p>
      <Link
        href="/"
        className="mt-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
      >
        Go to the marketplace
      </Link>
      <p className="mt-4 text-xs text-muted-foreground">Soo good you wanna gate keep</p>
    </main>
  );
}
