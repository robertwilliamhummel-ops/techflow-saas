import { describe, expect, it } from "vitest";
import {
  dashboardGuardRedirect,
  portalGuardRedirect,
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

  it("sends tenant members to the dashboard", () => {
    expect(
      portalGuardRedirect(verified, { tenantId: "t1", email_verified: true }),
    ).toBe("/dashboard");
  });

  it("sends customers without a verified email to the portal login", () => {
    expect(portalGuardRedirect(unverified, { email_verified: false })).toBe(
      "/portal/login",
    );
  });

  it("lets a verified customer in", () => {
    expect(portalGuardRedirect(verified, { email_verified: true })).toBeNull();
  });
});
