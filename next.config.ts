import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output is for local container builds; Vercel manages its own output.
  ...(process.env.VERCEL ? {} : { output: "standalone" as const }),
  typescript: {
    // Builds fail on type errors — the codebase is tsc-clean and must stay that way.
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
  // Baseline security headers (additive). The storefront may only be framed
  // by itself (in-app PayFast/Ozow frames return to our own origin), which
  // blocks clickjacking; nosniff + a strict referrer policy keep reset tokens
  // in `/?reset=` URLs from leaking to third-party hosts.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // The site (and the admin subdomain) are HTTPS-only behind Vercel —
          // tell browsers to stop trying plain HTTP for a year.
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          // Powerful browser features: location only for our own pages (the
          // delivery-address pin); microphone, browser payments and USB never.
          { key: 'Permissions-Policy', value: 'geolocation=(self), microphone=(), payment=(), usb=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
