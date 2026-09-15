// S-10 and custom domains — links to the portal and the pay page use the
// business's verified custom domain, else the shared portal host.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payPageUrl, portalDocumentUrl, portalOrigin } from "../../src/shared/portalLinks";

const ORIGINAL_APP_URL = process.env.APP_URL;

beforeEach(() => {
  process.env.APP_URL = "https://portal.example.test";
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = ORIGINAL_APP_URL;
});

const verified = {
  customDomain: "Invoices.SmithPlumbing.ca",
  customDomainStatus: { stage: "verified", message: null, checkedAt: null },
};

describe("portalOrigin", () => {
  it("uses a verified custom domain", () => {
    expect(portalOrigin(verified)).toBe("https://invoices.smithplumbing.ca");
  });

  it("uses the shared portal host until the domain is verified", () => {
    for (const stage of ["unverified", "dns_pending", "ssl_pending", "error"]) {
      expect(
        portalOrigin({ ...verified, customDomainStatus: { stage, message: null, checkedAt: null } }),
      ).toBe("https://portal.example.test");
    }
    expect(portalOrigin({ customDomain: null })).toBe("https://portal.example.test");
    expect(portalOrigin(undefined)).toBe("https://portal.example.test");
  });

  it("falls back to the production portal without APP_URL, and ignores a trailing slash", () => {
    delete process.env.APP_URL;
    expect(portalOrigin({})).toBe("https://portal.techflowsolutions.ca");
    process.env.APP_URL = "http://localhost:3000/";
    expect(portalOrigin({})).toBe("http://localhost:3000");
  });
});

describe("portalDocumentUrl", () => {
  it("links to the invoice or quote with its business", () => {
    expect(portalDocumentUrl({}, "invoice", "smith-plumbing", "INV-0042")).toBe(
      "https://portal.example.test/portal/invoices/INV-0042?tenantId=smith-plumbing",
    );
    expect(portalDocumentUrl(verified, "quote", "smith-plumbing", "QT-0007")).toBe(
      "https://invoices.smithplumbing.ca/portal/quotes/QT-0007?tenantId=smith-plumbing",
    );
  });
});

describe("payPageUrl", () => {
  it("links to the pay page on the business's host", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJ2IjoxfQ.sig-Part_2";
    expect(payPageUrl({}, token)).toBe(`https://portal.example.test/pay/${token}`);
    expect(payPageUrl(verified, token)).toBe(`https://invoices.smithplumbing.ca/pay/${token}`);
  });
});
