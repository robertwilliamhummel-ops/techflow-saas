import type { NextConfig } from "next";

// F-04 — sent with every response this app serves, on the portal host, the
// staging host, and tenant custom domains. Vercel already adds
// Strict-Transport-Security (max-age=63072000) on every host, so it isn't
// repeated here; includeSubDomains or preload would reach subdomains of
// tenant domains that TechFlow doesn't own.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Nothing frames these pages. frame-ancestors is the modern control and
  // overrides X-Frame-Options where a browser supports both. The dashboard's
  // PDF preview (an iframe of a blob: URL) is unaffected: CSP exempts local
  // URLs from frame-ancestors, and a blob: response carries no headers.
  { key: "X-Frame-Options", value: "DENY" },
  // frame-ancestors only. A blob: document inherits this policy, so a
  // directive such as object-src 'none' would block the browser's PDF viewer
  // in that preview; a script policy would have to cover Firebase Auth,
  // App Check (reCAPTCHA Enterprise), Stripe and Sentry.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // Builds type-check the app only. The root tsconfig also covers pdf-service
  // and the tests (which import functions/src), whose packages a Vercel
  // install doesn't have; `npx tsc --noEmit` still checks all of it.
  typescript: {
    tsconfigPath: "tsconfig.build.json",
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
      {
        // Privacy headers for the public pay page (C3 in REBUILD_PLAN).
        // The pay-token is bearer-auth in the URL — these headers stop
        // Referer leaks, search-engine indexing, and clickjacking.
        // Listed after the site-wide set: for the same key, the later entry wins.
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
