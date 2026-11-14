// F-04 — the response headers next.config.ts sends, worked out by Next's own
// matcher for `headers()`: every entry whose source matches applies, in order,
// so for the same key the later entry wins.

import { describe, expect, it } from "vitest";
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";

import nextConfig from "../../next.config";

async function headersFor(path: string): Promise<Headers> {
  const res = await unstable_getResponseFromNextConfig({
    url: `https://portal.techflowsolutions.ca${path}`,
    nextConfig,
  });
  return res.headers;
}

const SITE_WIDE: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  // frame-ancestors only: the dashboard's blob: PDF preview inherits this
  // policy, and CSP exempts local URLs from frame-ancestors alone.
  "content-security-policy": "frame-ancestors 'none'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

// A pay token is a JWT, so its path segment has dots.
const PAY_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJpbnZvaWNlSWQiOiJJTlYtMDAwMSJ9.c2lnbmF0dXJl";

describe("F-04 — security headers on every response", () => {
  it.each([
    "/",
    "/login",
    "/dashboard",
    "/invoices/INV-0001",
    "/settings/payments",
    "/portal",
    "/portal/login?next=%2Fportal",
    "/portal/invoices/INV-0001?tenantId=acme-plumbing",
    "/accept-invite?tenantId=acme-plumbing&invitationId=i1&token=t",
    "/auth/action?mode=resetPassword&oobCode=code",
    "/api/pdf/invoice",
    "/api/webhooks/stripe/connect",
    "/_next/static/chunks/main.js",
    "/favicon.ico",
  ])("%s", async (path) => {
    const headers = await headersFor(path);
    for (const [key, value] of Object.entries(SITE_WIDE)) {
      expect(headers.get(key), key).toBe(value);
    }
    // The pay page's noindex stays on the pay page.
    expect(headers.get("x-robots-tag")).toBeNull();
  });

  it("leaves Strict-Transport-Security to Vercel, which sends it on every host", async () => {
    expect((await headersFor("/login")).get("strict-transport-security")).toBeNull();
  });

  it("doesn't advertise Next.js in X-Powered-By", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

describe("C3 — the pay page keeps its stricter privacy headers", () => {
  it.each([
    `/pay/${PAY_TOKEN}`,
    `/pay/${PAY_TOKEN}/success`,
    `/pay/${PAY_TOKEN}/cancelled`,
  ])("%s", async (path) => {
    const headers = await headersFor(path);
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(headers.get("permissions-policy")).toBe(SITE_WIDE["permissions-policy"]);
  });
});
