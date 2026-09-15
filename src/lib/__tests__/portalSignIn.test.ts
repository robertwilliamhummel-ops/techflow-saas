import { describe, expect, it } from "vitest";
import {
  requestLinkErrorMessage,
  signInContinueUrl,
  signInLinkFailure,
  tenantIdFromReturnPath,
} from "../portal/portalSignIn";

describe("signInContinueUrl", () => {
  it("returns to this site's portal login with the page to open next", () => {
    expect(
      signInContinueUrl("https://invoices.smithplumbing.ca", "/portal/invoices/INV-0042?tenantId=smith"),
    ).toBe(
      "https://invoices.smithplumbing.ca/portal/login?next=%2Fportal%2Finvoices%2FINV-0042%3FtenantId%3Dsmith",
    );
  });

  it("leaves out a next that isn't a portal page, or is the portal home", () => {
    expect(signInContinueUrl("http://localhost:3000", "https://evil.example")).toBe(
      "http://localhost:3000/portal/login",
    );
    expect(signInContinueUrl("http://localhost:3000", "/portal")).toBe(
      "http://localhost:3000/portal/login",
    );
    expect(signInContinueUrl("http://localhost:3000", null)).toBe("http://localhost:3000/portal/login");
  });
});

describe("tenantIdFromReturnPath", () => {
  it("reads a valid tenantId from a portal page", () => {
    expect(tenantIdFromReturnPath("/portal/invoices/INV-1?tenantId=bobs-plumbing")).toBe("bobs-plumbing");
  });

  it("ignores missing, malformed, or off-portal values", () => {
    expect(tenantIdFromReturnPath("/portal/invoices/INV-1")).toBeNull();
    expect(tenantIdFromReturnPath("/portal/invoices/INV-1?tenantId=a%2Fb")).toBeNull();
    expect(tenantIdFromReturnPath("/dashboard?tenantId=bobs-plumbing")).toBeNull();
    expect(tenantIdFromReturnPath(null)).toBeNull();
  });
});

describe("signInLinkFailure", () => {
  it("asks for the address again when it doesn't match the link", () => {
    expect(signInLinkFailure({ code: "auth/invalid-email" })).toEqual({
      kind: "wrong-email",
      message: "That isn't the email address this sign-in link was sent to.",
    });
  });

  it("offers a new link for an expired or used one", () => {
    expect(signInLinkFailure({ code: "auth/expired-action-code" }).kind).toBe("unusable-link");
    expect(signInLinkFailure({ code: "auth/invalid-action-code" })).toMatchObject({
      kind: "unusable-link",
      message: expect.stringMatching(/already been used/),
    });
  });

  it("explains anything else in the usual words", () => {
    expect(signInLinkFailure({ code: "auth/network-request-failed" })).toEqual({
      kind: "other",
      message: "Network error. Check your connection and try again.",
    });
  });
});

describe("requestLinkErrorMessage", () => {
  it("names a bad address, and otherwise suggests trying again", () => {
    expect(requestLinkErrorMessage({ code: "functions/invalid-argument" })).toBe("Enter a valid email address.");
    expect(requestLinkErrorMessage({ code: "functions/unavailable" })).toMatch(/couldn't be sent/);
    expect(requestLinkErrorMessage(new Error("offline"))).toMatch(/couldn't be sent/);
  });
});
