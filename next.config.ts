import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output is for local container builds; Vercel manages its own output.
  ...(process.env.VERCEL ? {} : { output: "standalone" as const }),
  typescript: {
    // Builds fail on type errors — the codebase is tsc-clean and must stay that way.
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
};

export default nextConfig;
