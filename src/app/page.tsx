import { Suspense } from 'react';
import { AppShell } from '@/components/greengate/app-shell';

export default function Home() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading Green Gate…</div>}>
      <AppShell />
    </Suspense>
  );
}
