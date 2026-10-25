import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { Providers } from "@/components/greengate/providers";

const SITE_URL = process.env.NEXTAUTH_URL ?? "https://greengatemarket.store";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Green Gate — The marketplace for everyone",
    template: "%s — Green Gate",
  },
  description:
    "Green Gate is a multi-vendor marketplace for anything and everything. Real sellers, real products, nationwide courier delivery. Soo good you wanna gate keep.",
  keywords: ["marketplace", "multi-vendor", "shop anything", "sell anything", "e-commerce", "Green Gate", "South Africa"],
  openGraph: {
    title: "Green Gate — Shop anything, sell anything",
    description: "A marketplace for everyone. Everything you need across South Africa — with real sellers, nationwide delivery and straightforward returns. Soo good you wanna gate keep.",
    siteName: "Green Gate",
    type: "website",
    url: SITE_URL,
    images: [{ url: "/og-image.jpg", width: 1344, height: 768, alt: "Green Gate — Multi-vendor marketplace" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Green Gate — Shop anything, sell anything",
    description: "A marketplace for everyone. Everything you need across South Africa — with real sellers, nationwide delivery and straightforward returns.",
    images: ["/og-image.jpg"],
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/manifest.webmanifest",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#16a34a",
};

/** ES5 fillers for older phone / smart-TV browsers (no-ops on modern ones):
 *  globalThis, Promise.allSettled, AbortSignal.timeout, queueMicrotask. */
const LEGACY_POLYFILLS = `(function(){var g=typeof self!=='undefined'?self:window;if(typeof globalThis==='undefined'){g.globalThis=g;}if(typeof Promise!=='undefined'&&!Promise.allSettled){Promise.allSettled=function(items){return Promise.all(Array.prototype.map.call(Array.from(items),function(p){return Promise.resolve(p).then(function(v){return{status:'fulfilled',value:v};},function(r){return{status:'rejected',reason:r};});}));};}if(typeof AbortController!=='undefined'&&typeof AbortSignal!=='undefined'&&!AbortSignal.timeout){AbortSignal.timeout=function(ms){var c=new AbortController();setTimeout(function(){try{c.abort(new DOMException('The operation timed out.','TimeoutError'));}catch(e){c.abort();}},ms);return c.signal;};}if(typeof g.queueMicrotask!=='function'){g.queueMicrotask=function(cb){Promise.resolve().then(cb)['catch'](function(e){setTimeout(function(){throw e;});});};}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        {/* Older phone / smart-TV browsers (Samsung Internet, Android
            WebView, Tizen/VIDAA — Chromium 69+): fill the few modern APIs
            the app uses before any app code runs. ES5 only, no-ops on
            modern browsers. See postcss-legacy-compat.cjs for the CSS side. */}
        <Script id="legacy-polyfills" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: LEGACY_POLYFILLS }} />
        {/* Structured data so search engines show the Green Gate name and logo
            on results for greengatemarket.store (Organization logo + WebSite
            sitename, the two pieces Google reads for brand display). */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "Organization",
                  "@id": `${SITE_URL}/#organization`,
                  name: "Green Gate",
                  url: SITE_URL,
                  slogan: "Soo good you wanna gate keep",
                  logo: {
                    "@type": "ImageObject",
                    url: `${SITE_URL}/icon-512.png`,
                    width: 512,
                    height: 512,
                  },
                  image: `${SITE_URL}/og-image.jpg`,
                },
                {
                  "@type": "WebSite",
                  "@id": `${SITE_URL}/#website`,
                  url: SITE_URL,
                  name: "Green Gate",
                  publisher: { "@id": `${SITE_URL}/#organization` },
                },
                {
                  // Machine-readable ecommerce signal for search engines AND
                  // payment-processor domain verification (PayFast, Ozow, Yoco):
                  // this domain is an online marketplace, what it sells, where
                  // it operates, and exactly how buyers pay.
                  "@type": "OnlineStore",
                  "@id": `${SITE_URL}/#store`,
                  name: "Green Gate",
                  url: SITE_URL,
                  description:
                    "Multi-vendor South African marketplace — thousands of independent sellers, nationwide Courier Guy delivery, buyers pay in-app.",
                  parentOrganization: { "@id": `${SITE_URL}/#organization` },
                  logo: `${SITE_URL}/icon-512.png`,
                  image: `${SITE_URL}/og-image.jpg`,
                  currenciesAccepted: "ZAR",
                  paymentAccepted:
                    "Visa, Mastercard, PayFast (card and instant EFT), Ozow instant EFT, Yoco, Bank transfer (EFT)",
                  areaServed: "ZA",
                  openingHours: "Mo-Su 00:00-24:00",
                },
              ],
            }),
          }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
