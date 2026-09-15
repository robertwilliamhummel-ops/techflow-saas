import { describe, expect, it } from "vitest";
import {
  dashboardGuardRedirect,
  portalGuardRedirect,
  portalLoginHref,
  safePortalReturnPath,
} from "@/lib/auth/guardRedirects";

const verified = { emailVerified: true };
const unverified = { emailVerified: false };

describe("dashboardGuardRedirect", () => {
  it("sends signed-out visitors to login", () => {
    expect(dashboardGuardRedirect(null, {})).toBe("/login");
  });

  it("lets a verified tenant member in", () => {
    expect(
      dashboardGuardRedirect(verified, { tenantId: "t1", role: "owner" }),
    ).toBeNull();
  });

  it("sends a tenant member with an unverified email to /verify-email", () => {
    // A new owner lands here straight from signup.
    expect(
      dashboardGuardRedirect(unverified, { tenantId: "t1", role: "owner" }),
    ).toBe("/verify-email");
  });

  it("trusts the reloaded user over a stale email_verified claim", () => {
    // After the link is clicked, user.reload() flips emailVerified while the
    // cached token still says false.
    expect(
      dashboardGuardRedirect(verified, { tenantId: "t1", email_verified: false }),
    ).toBeNull();
  });

  it("sends a verified customer without a tenant to the portal", () => {
    expect(dashboardGuardRedirect(verified, { email_verified: true })).toBe(
      "/portal",
    );
  });

  it("sends an unverified user without a tenant to login", () => {
    expect(dashboardGuardRedirect(unverified, {})).toBe("/login");
  });
});

describe("portalGuardRedirect", () => {
  it("sends signed-out visitors to the portal login", () => {
    expect(portalGuardRedirect(null, {})).toBe("/portal/login");
  });

  it("S-10: remembers the page a signed-out visitor asked for", () => {
    expect(
      portalGuardRedirect(null, {}, "/portal/invoices/INV-0001?tenantId=acme"),
    ).toBe("/portal/login?next=%2Fportal%2Finvoices%2FINV-0001%3FtenantId%3Dacme");
  });

  it("sends tenant members to the dashboard", () => {
    expect(
      portalGuardRedirect(verified, { tenantId: "t1", email_verified: true }),
    ).toBe("/dashboard");
  });

  it("sends customers without a verified email to the portal login", () => {
    expect(portalGuardRedirect(unverified, { email_verified: false })).toBe(
      "/portal/login",
    );
    expect(
      portalGuardRedirect(unverified, { email_verified: false }, "/portal/quotes/QT-1?tenantId=a"),
    ).toBe("/portal/login?next=%2Fportal%2Fquotes%2FQT-1%3FtenantId%3Da");
  });

  it("lets a verified customer in", () => {
    expect(portalGuardRedirect(verified, { email_verified: true })).toBeNull();
  });
});

describe("safePortalReturnPath", () => {
  it("keeps a portal page with its query", () => {
    expect(safePortalReturnPath("/portal")).toBe("/portal");
    expect(safePortalReturnPath("/portal/invoices/INV-0001?tenantId=acme")).toBe(
      "/portal/invoices/INV-0001?tenantId=acme",
    );
  });

  it("refuses anything that could leave the portal or loop back to the login", () => {
    for (const bad of [
      "https://evil.example/portal",
      "//evil.example/portal",
      "/\\evil.example",
      "/portalx",
      "/dashboard",
      "/portal/../dashboard",
      "/portal/login",
      "/portal/login?next=/portal",
      "portal/invoices/1",
      "",
      null,
      undefined,
      `/portal/${"x".repeat(1000)}`,
    ]) {
      expect(safePortalReturnPath(bad)).toBeNull();
    }
  });

  it("drops a fragment", () => {
    expect(safePortalReturnPath("/portal/invoices/INV-1?tenantId=a#top")).toBe(
      "/portal/invoices/INV-1?tenantId=a",
    );
  });
});

describe("portalLoginHref", () => {
  it("adds next only for a portal page other than the home", () => {
    expect(portalLoginHref()).toBe("/portal/login");
    expect(portalLoginHref("/portal")).toBe("/portal/login");
    expect(portalLoginHref("https://evil.example")).toBe("/portal/login");
    expect(portalLoginHref("/portal/invoices/INV-1?tenantId=a")).toBe(
      "/portal/login?next=%2Fportal%2Finvoices%2FINV-1%3FtenantId%3Da",
    );
  });
});
