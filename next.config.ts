import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output is for local container builds; Vercel manages its own output.
  ...(process.env.VERCEL ? {} : { output: "standalone" as const }),
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
