// A-12 — the client reads the roles Cloud Functions actually write
// (owner | admin | staff), not the old member/platform_admin names.
// F-02 — and holds a token whose email_verified matches the user's.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ getClientAuth: vi.fn() }));
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: vi.fn(),
  signOut: vi.fn(),
}));

const { currentIdTokenResult, extractClaims, getPostLoginRoute } = await import(
  "@/lib/auth/useAuth"
);

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

describe("currentIdTokenResult (F-02)", () => {
  // A user whose cached token carries `cached`; a forced refresh returns a
  // token saying verified, or fails when `offline`.
  function signedIn(emailVerified: boolean, cached: boolean, offline = false) {
    const getIdTokenResult = vi.fn(async (force?: boolean) => {
      if (!force) return token({ email_verified: cached });
      if (offline) throw new Error("auth/network-request-failed");
      return token({ email_verified: true });
    });
    return { user: { emailVerified, getIdTokenResult } as never, getIdTokenResult };
  }

  it("refreshes a token minted before the email was verified", async () => {
    const { user, getIdTokenResult } = signedIn(true, false);
    const result = await currentIdTokenResult(user);
    expect(getIdTokenResult).toHaveBeenLastCalledWith(true);
    expect(result.claims.email_verified).toBe(true);
  });

  it("keeps a cached token that already says verified", async () => {
    const { user, getIdTokenResult } = signedIn(true, true);
    await currentIdTokenResult(user);
    expect(getIdTokenResult).toHaveBeenCalledTimes(1);
    expect(getIdTokenResult).not.toHaveBeenCalledWith(true);
  });

  it("doesn't refresh while the email is still unverified", async () => {
    const { user, getIdTokenResult } = signedIn(false, false);
    const result = await currentIdTokenResult(user);
    expect(getIdTokenResult).toHaveBeenCalledTimes(1);
    expect(result.claims.email_verified).toBe(false);
  });

  it("keeps the cached token when the refresh fails", async () => {
    const { user } = signedIn(true, false, true);
    const result = await currentIdTokenResult(user);
    expect(result.claims.email_verified).toBe(false);
  });
});
