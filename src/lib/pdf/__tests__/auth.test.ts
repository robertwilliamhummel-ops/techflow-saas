import { describe, expect, it, vi } from "vitest";
import {
  PdfAuthError,
  authorizePdfAccess,
  readBearerToken,
  verifyIdToken,
} from "../auth";
import type { DecodedIdToken } from "firebase-admin/auth";

const verify = vi.fn();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminAuth: () => ({ verifyIdToken: verify }),
}));

function makeRequest(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/pdf/invoice", { headers });
}

function decodedFor(overrides: Partial<DecodedIdToken & { tenantId?: string }>): DecodedIdToken {
  return {
    uid: "u1",
    aud: "test",
    auth_time: 0,
    exp: 0,
    iat: 0,
    iss: "",
    sub: "u1",
    firebase: { identities: {}, sign_in_provider: "custom" },
    ...overrides,
  } as DecodedIdToken;
}

const VISIBLE = { tenantId: "acme", customerEmail: "jane@example.com", customerMayView: true };

describe("readBearerToken", () => {
  it("extracts token from Authorization: Bearer", () => {
    expect(readBearerToken(makeRequest({ authorization: "Bearer abc.def" }))).toBe("abc.def");
  });

  it("is case-insensitive on the scheme", () => {
    expect(readBearerToken(makeRequest({ authorization: "bearer xyz" }))).toBe("xyz");
  });

  it("rejects when header is missing", () => {
    expect(() => readBearerToken(makeRequest({}))).toThrow(PdfAuthError);
  });

  it("rejects when scheme is not Bearer", () => {
    expect(() =>
      readBearerToken(makeRequest({ authorization: "Basic abc" })),
    ).toThrow(PdfAuthError);
  });

  it("rejects empty bearer token", () => {
    expect(() =>
      readBearerToken(makeRequest({ authorization: "Bearer " })),
    ).toThrow(PdfAuthError);
  });
});

describe("verifyIdToken", () => {
  it("returns decoded token on success", async () => {
    verify.mockResolvedValueOnce({ uid: "abc" });
    const decoded = await verifyIdToken("good-token");
    expect(decoded.uid).toBe("abc");
  });

  it("wraps verification errors as 401 PdfAuthError", async () => {
    verify.mockRejectedValueOnce(new Error("token expired"));
    await expect(verifyIdToken("bad")).rejects.toMatchObject({
      status: 401,
      name: "PdfAuthError",
    });
  });
});

describe("authorizePdfAccess (tenant mode)", () => {
  it("accepts when token tenantId matches invoice tenantId", () => {
    const result = authorizePdfAccess(
      decodedFor({ tenantId: "acme" }),
      { ...VISIBLE, customerEmail: "anyone@x.com" },
    );
    expect(result).toEqual({ uid: "u1", mode: "tenant" });
  });

  it("S-08: a business sees its own drafts", () => {
    const result = authorizePdfAccess(
      decodedFor({ tenantId: "acme" }),
      { ...VISIBLE, customerMayView: false },
    );
    expect(result).toEqual({ uid: "u1", mode: "tenant" });
  });

  it("rejects when token tenantId mismatches invoice tenantId", () => {
    expect(() =>
      authorizePdfAccess(
        decodedFor({ tenantId: "other" }),
        { ...VISIBLE, customerEmail: "x@y.com" },
      ),
    ).toThrow(/Tenant claim does not match/);
  });
});

describe("authorizePdfAccess (customer mode)", () => {
  it("accepts when email_verified and email matches (case-insensitive)", () => {
    const result = authorizePdfAccess(
      decodedFor({ email: "Jane@Example.COM", email_verified: true }),
      VISIBLE,
    );
    expect(result).toEqual({ uid: "u1", mode: "customer" });
  });

  it("S-08: answers 404 when the document is one customers don't see", () => {
    expect(() =>
      authorizePdfAccess(
        decodedFor({ email: "jane@example.com", email_verified: true }),
        { ...VISIBLE, customerMayView: false },
      ),
    ).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("S-08: a stranger gets the same 403 whatever the document's status", () => {
    for (const customerMayView of [true, false]) {
      expect(() =>
        authorizePdfAccess(
          decodedFor({ email: "someone-else@example.com", email_verified: true }),
          { ...VISIBLE, customerMayView },
        ),
      ).toThrow(expect.objectContaining({ status: 403 }));
    }
  });

  it("rejects when email is not verified", () => {
    expect(() =>
      authorizePdfAccess(
        decodedFor({ email: "jane@example.com", email_verified: false }),
        VISIBLE,
      ),
    ).toThrow(PdfAuthError);
  });

  it("rejects when email mismatches", () => {
    expect(() =>
      authorizePdfAccess(
        decodedFor({ email: "someone-else@example.com", email_verified: true }),
        VISIBLE,
      ),
    ).toThrow(PdfAuthError);
  });

  it("rejects when no email and no tenantId claim", () => {
    expect(() =>
      authorizePdfAccess(decodedFor({}), VISIBLE),
    ).toThrow(PdfAuthError);
  });
});
