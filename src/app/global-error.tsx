'use client';

import { useEffect } from 'react';

/**
 * Global error boundary (App Router convention: src/app/global-error.tsx).
 *
 * This is the LAST-RESORT boundary — it replaces the default Next.js
 * "Application error: a client-side exception has occurred" screen. Nothing
 * in the app may ever show that dead-end page again: whatever escapes the
 * route boundary lands here and gets a branded, self-healing recovery screen.
 *
 * Self-healing: the most common real-world trigger of a root-level client
 * exception is a transient environment failure — a stale JS chunk after a
 * deployment, a network blip mid-boot, or a serverless instance returning an
 * unexpected payload for one request. A single reload re-syncs the client
 * with the current deployment. We reload ONCE per browser session
 * (sessionStorage guard — can never loop) when the error looks transient,
 * then always show the manual controls.
 *
 * Self-contained by design: this component renders its own <html>/<body> and
 * uses inline styles because global CSS is not guaranteed to be loaded when
 * the root layout itself has been bypassed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Green Gate global error:', error);

    const KEY = 'gg-crash-selfheal';
    let message = '';
    try {
      message = (error?.message ?? '').toLowerCase();
    } catch {
      message = '';
    }
    const looksTransient =
      /chunk|dynamically imported|importing a module|failed to fetch|load failed|network|server/i.test(message);

    let alreadyHealed: string | null = null;
    try {
      alreadyHealed = window.sessionStorage.getItem(KEY);
    } catch {
      alreadyHealed = null;
    }

    if (looksTransient && !alreadyHealed) {
      try {
        window.sessionStorage.setItem(KEY, '1');
      } catch {
        // storage unavailable — reload anyway; the flag only prevents loops
      }
      window.location.reload();
      return;
    }
    // Persistent error (or already self-healed once): keep the manual screen.
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 24,
          background: '#ffffff',
          color: '#1c2b22',
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
          textAlign: 'center',
        }}
      >
        <div
          aria-hidden
          style={{
            width: 48,
            height: 48,
            borderRadius: 10,
            background: '#f0fdf4',
            border: '1px solid #bbf7d0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21.801 10A10 10 0 1 1 17 3.335" />
            <path d="m9 11 3 3L22 4" />
          </svg>
        </div>
        <p
          style={{
            margin: 0,
            fontWeight: 700,
            letterSpacing: '0.08em',
            fontSize: 12,
            color: '#16a34a',
            textTransform: 'uppercase',
          }}
        >
          Green Gate
        </p>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
          We hit an unexpected error
        </h1>
        <p style={{ margin: 0, maxWidth: 420, fontSize: 14, lineHeight: 1.6, color: '#4b5563' }}>
          Something interrupted the app while loading. Your account and data are safe — a quick reload usually brings everything back.
        </p>
        {error?.digest ? (
          <p style={{ margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: '#6b7280' }}>
            Reference: {error.digest}
          </p>
        ) : null}
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              cursor: 'pointer',
              borderRadius: 6,
              border: '1px solid #16a34a',
              background: '#16a34a',
              color: '#ffffff',
              padding: '10px 18px',
              fontSize: 14,
              fontWeight: 600,
              minHeight: 44,
            }}
          >
            Reload the page
          </button>
          <button
            type="button"
            onClick={() => {
              try {
                window.sessionStorage.setItem('gg-crash-selfheal', '1');
              } catch {
                // ignore — manual navigation, loop guard irrelevant
              }
              window.location.assign('/');
            }}
            style={{
              cursor: 'pointer',
              borderRadius: 6,
              border: '1px solid #d1d5db',
              background: '#ffffff',
              color: '#1c2b22',
              padding: '10px 18px',
              fontSize: 14,
              fontWeight: 600,
              minHeight: 44,
            }}
          >
            Go to homepage
          </button>
        </div>
      </body>
    </html>
  );
}
