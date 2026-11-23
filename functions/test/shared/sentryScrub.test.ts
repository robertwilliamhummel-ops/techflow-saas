// Nothing secret or customer-identifying leaves Cloud Functions for Sentry:
// request bodies (pay tokens, invoice data), auth headers and pay tokens in
// URLs are stripped before an event is sent.

import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/node";
import { scrubBreadcrumb, scrubEvent, scrubUrl } from "../../src/shared/sentryScrub";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJpbnZvaWNlSWQiOiJJTlYtMDAwMSJ9.sig-Abc_123";

describe("Sentry scrubbing (functions)", () => {
  it("masks pay tokens and sign-in codes in URLs", () => {
    expect(scrubUrl(`https://portal.techflowsolutions.ca/pay/${TOKEN}?lang=en`)).toBe(
      "https://portal.techflowsolutions.ca/pay/[token]?lang=en",
    );
    expect(scrubUrl("/portal?oobCode=ABC&apiKey=XYZ")).toBe(
      "/portal?oobCode=[redacted]&apiKey=[redacted]",
    );
  });

  it("drops the request body, cookies and every header but user-agent and content-type", () => {
    const event = {
      request: {
        url: "https://northamerica-northeast2-x.cloudfunctions.net/getPayInvoice",
        method: "POST",
        data: { data: { token: TOKEN, customerEmail: "a@b.c" } },
        cookies: { s: "1" },
        headers: {
          Authorization: "Bearer idtoken",
          "X-Firebase-AppCheck": "appcheck",
          "User-Agent": "ua",
          "Content-Type": "application/json",
        },
      },
      breadcrumbs: [{ category: "http", data: { url: `https://x/pay/${TOKEN}` } }],
    } as unknown as ErrorEvent;
    const out = scrubEvent(event);
    const text = JSON.stringify(out);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("a@b.c");
    expect(text).not.toContain("idtoken");
    expect(text).not.toContain("appcheck");
    expect(out.request?.headers).toEqual({ "User-Agent": "ua", "Content-Type": "application/json" });
    expect(out.request?.method).toBe("POST");
  });

  it("scrubs breadcrumb messages and URLs", () => {
    const crumb = scrubBreadcrumb({ message: `GET /pay/${TOKEN}`, data: { url: `/pay/${TOKEN}` } });
    expect(crumb.message).toBe("GET /pay/[token]");
    expect(crumb.data?.url).toBe("/pay/[token]");
  });
});
