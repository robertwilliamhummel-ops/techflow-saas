import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";

export type MembershipRole = "owner" | "admin" | "staff";

export interface AuthedClaims {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  tenantId: string | null;
  role: MembershipRole | null;
  platformAdmin: boolean;
}

export function readClaims(request: CallableRequest): AuthedClaims {
  const auth = request.auth;
  if (!auth) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const token = auth.token as Record<string, unknown>;
  return {
    uid: auth.uid,
    email: typeof token.email === "string" ? token.email : null,
    emailVerified: token.email_verified === true,
    tenantId: typeof token.tenantId === "string" ? token.tenantId : null,
    role: isRole(token.role) ? token.role : null,
    platformAdmin: token.platformAdmin === true,
  };
}

export function requireTenant(claims: AuthedClaims): {
  uid: string;
  tenantId: string;
  role: MembershipRole;
} {
  if (!claims.tenantId || !claims.role) {
    throw new HttpsError("permission-denied", "Tenant membership required.");
  }
  return { uid: claims.uid, tenantId: claims.tenantId, role: claims.role };
}

export function requireRole(
  claims: AuthedClaims,
  allowed: readonly MembershipRole[],
): void {
  if (!claims.role || !allowed.includes(claims.role)) {
    throw new HttpsError(
      "permission-denied",
      `Requires one of: ${allowed.join(", ")}.`,
    );
  }
}

export function requireVerifiedCustomer(claims: AuthedClaims): {
  uid: string;
  email: string;
} {
  if (!claims.email || !claims.emailVerified) {
    throw new HttpsError("unauthenticated", "Verified email required.");
  }
  return { uid: claims.uid, email: claims.email };
}

function isRole(v: unknown): v is MembershipRole {
  return v === "owner" || v === "admin" || v === "staff";
}
