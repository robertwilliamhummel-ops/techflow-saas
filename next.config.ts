import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Builds type-check the app only. The root tsconfig also covers pdf-service
  // and the tests (which import functions/src), whose packages a Vercel
  // install doesn't have; `npx tsc --noEmit` still checks all of it.
  typescript: {
    tsconfigPath: "tsconfig.build.json",
  },
  async headers() {
    return [
      {
        // Privacy headers for the public pay page (C3 in REBUILD_PLAN).
        // The pay-token is bearer-auth in the URL — these headers stop
        // Referer leaks, search-engine indexing, and clickjacking.
        source: "/pay/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
