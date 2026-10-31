/**
 * Runs once when each server starts (Next.js instrumentation hook).
 * Captures server errors for the in-app monitor — see src/lib/app-errors.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { installServerErrorCapture } = await import('./lib/app-errors');
  await installServerErrorCapture();
}
