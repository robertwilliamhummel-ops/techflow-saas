import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import { scrubBreadcrumb, scrubEvent, scrubUrl, sentryOptions } from "../sentry/scrub";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJpbnZvaWNlSWQiOiJJTlYtMDAwMSJ9.sig-Abc_123";

describe("Sentry scrubbing", () => {
  it("replaces pay tokens in URLs and paths", () => {
    expect(scrubUrl(`https://portal.techflowsolutions.ca/pay/${TOKEN}`)).toBe(
      "https://portal.techflowsolutions.ca/pay/[token]",
    );
    expect(scrubUrl(`/pay/${TOKEN}/success?x=1`)).toBe("/pay/[token]/success?x=1");
  });

  it("redacts sign-in link codes but keeps harmless query values", () => {
    const url =
      "https://portal.techflowsolutions.ca/portal?apiKey=AIzaXYZ&oobCode=CODE123&mode=signIn&lang=en&continueUrl=https%3A%2F%2Fx";
    const out = scrubUrl(url);
    expect(out).not.toContain("CODE123");
    expect(out).not.toContain("AIzaXYZ");
    expect(out).toContain("lang=en");
    expect(out).toContain("oobCode=[redacted]");
  });

  it("scrubs the event's request, referer, transaction and breadcrumbs, and drops auth headers", () => {
    const event = {
      request: {
        url: `https://portal.techflowsolutions.ca/pay/${TOKEN}`,
        query_string: "oobCode=SECRET&page=2",
        headers: { Referer: `https://x/pay/${TOKEN}`, Authorization: "Bearer abc", Cookie: "s=1" },
        cookies: { s: "1" },
      },
      transaction: `/pay/${TOKEN}`,
      breadcrumbs: [{ category: "navigation", data: { from: "/dashboard", to: `/pay/${TOKEN}` } }],
    } as unknown as ErrorEvent;
    const out = JSON.stringify(scrubEvent(event));
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("Bearer abc");
    expect(out).toContain("page=2");
  });

  it("scrubs fetch breadcrumb URLs", () => {
    const crumb = scrubBreadcrumb({ category: "fetch", data: { url: `/pay/${TOKEN}?oobCode=Z` } });
    expect(crumb.data?.url).toBe("/pay/[token]?oobCode=[redacted]");
  });

  it("is errors only with no default PII", () => {
    const opts = sentryOptions("https://x@o1.ingest.us.sentry.io/1");
    expect(opts.tracesSampleRate).toBe(0);
    expect(opts.sendDefaultPii).toBe(false);
  });
});
