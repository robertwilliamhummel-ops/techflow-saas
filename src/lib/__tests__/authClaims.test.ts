// A-12 — the client reads the roles Cloud Functions actually write
// (owner | admin | staff), not the old member/platform_admin names.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ getClientAuth: vi.fn() }));
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: vi.fn(),
  signOut: vi.fn(),
}));

const { extractClaims, getPostLoginRoute } = await import("@/lib/auth/useAuth");

function token(claims: Record<string, unknown>) {
  return { claims } as never;
}

describe("extractClaims (A-12)", () => {
  it.each(["owner", "admin", "staff"])("keeps the %s role", (role) => {
    expect(extractClaims(token({ tenantId: "t1", role })).role).toBe(role);
  });

  it.each(["member", "platform_admin", "OWNER", 1])(
    "drops the unknown role %j",
    (role) => {
      expect(extractClaims(token({ tenantId: "t1", role })).role).toBeUndefined();
    },
  );

  it("reads platform admins from the separate platformAdmin claim", () => {
    expect(extractClaims(token({ platformAdmin: true })).platformAdmin).toBe(true);
    expect(extractClaims(token({ platformAdmin: "true" })).platformAdmin).toBe(false);
  });

  it("ignores a wrongly typed tenantId or email_verified", () => {
    expect(extractClaims(token({ tenantId: 42, email_verified: "yes" }))).toEqual({
      tenantId: undefined,
      role: undefined,
      platformAdmin: false,
      email_verified: undefined,
    });
  });

  it("returns no claims when signed out", () => {
    expect(extractClaims(null)).toEqual({});
  });

  it("sends a staff member to the dashboard", () => {
    const claims = extractClaims(
      token({ tenantId: "t1", role: "staff", email_verified: true }),
    );
    expect(getPostLoginRoute(claims)).toBe("/dashboard");
  });
});
