import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import './globals.css';

export const metadata: Metadata = {
  title: 'Green Gate — Admin Console',
  description: 'Operate the Green Gate marketplace: insights, stores, orders, users, API usage and billing.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#14532d',
};

/** ES5 fillers for older phone / smart-TV browsers (no-ops on modern ones):
 *  globalThis, Promise.allSettled, AbortSignal.timeout, queueMicrotask.
 *  Same snippet the marketplace ships (src/app/layout.tsx) — parity so the
 *  console opens on the same devices the store does. */
const LEGACY_POLYFILLS = `(function(){var g=typeof self!=='undefined'?self:window;if(typeof globalThis==='undefined'){g.globalThis=g;}if(typeof Promise!=='undefined'&&!Promise.allSettled){Promise.allSettled=function(items){return Promise.all(Array.prototype.map.call(Array.from(items),function(p){return Promise.resolve(p).then(function(v){return{status:'fulfilled',value:v};},function(r){return{status:'rejected',reason:r};});}));};}if(typeof AbortController!=='undefined'&&typeof AbortSignal!=='undefined'&&!AbortSignal.timeout){AbortSignal.timeout=function(ms){var c=new AbortController();setTimeout(function(){try{c.abort(new DOMException('The operation timed out.','TimeoutError'));}catch(e){c.abort();}},ms);return c.signal;};}if(typeof g.queueMicrotask!=='function'){g.queueMicrotask=function(cb){Promise.resolve().then(cb)['catch'](function(e){setTimeout(function(){throw e;});});};}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Older phone / smart-TV browsers (Chromium 69+): fill the few modern
            APIs the console uses before any app code runs. ES5 only, no-ops on
            modern browsers. */}
        <Script id="legacy-polyfills" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: LEGACY_POLYFILLS }} />
        {children}
      </body>
    </html>
  );
}
