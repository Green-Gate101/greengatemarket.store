import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The console is a self-contained app: no external font/image hosts, no
  // special output mode. It talks to the marketplace purely server-side.
  reactStrictMode: true,
  // The console must never be framed (clickjacking on destructive admin
  // actions), sniffed, indexed or leak its URLs via Referer.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

export default nextConfig;
