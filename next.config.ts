import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
