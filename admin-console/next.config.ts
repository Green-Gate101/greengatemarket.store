import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The console is a self-contained app: no external font/image hosts, no
  // special output mode. It talks to the marketplace purely server-side.
  reactStrictMode: true,
};

export default nextConfig;
