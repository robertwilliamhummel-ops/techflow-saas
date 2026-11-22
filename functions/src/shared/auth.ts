import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { db } from "./admin";

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

export const VERIFY_EMAIL_MESSAGE =
  "Verify your email address first: open the link we emailed you, then try again.";

export const REMOVED_MEMBER_MESSAGE =
  "You're no longer a member of this business.";

/**
 * A tenant member whose ID token says their email is verified. Every tenant
 * callable starts here, so none of them can create, change, send, or preview
 * anything for an unverified account (F-02) — the server copy of the
 * dashboard's email verification gate. Signup, accepting an invitation, and
 * resending the verification email don't come through here.
 *
 * D21: the caller's membership (userTenantMemberships/{uid}_{tenantId}) must
 * also exist and not be deleted. removeMember clears the claims and revokes
 * refresh tokens, but an ID token minted before that keeps its tenant claim
 * for up to an hour; this one document read per call refuses it at once. It is
 * also what makes deleting a membership in the Console take effect.
 */
export async function requireTenant(claims: AuthedClaims): Promise<{
  uid: string;
  tenantId: string;
  role: MembershipRole;
}> {
  if (!claims.tenantId || !claims.role) {
    throw new HttpsError("permission-denied", "Tenant membership required.");
  }
  if (!claims.emailVerified) {
    throw new HttpsError("failed-precondition", VERIFY_EMAIL_MESSAGE);
  }
  const membership = await db
    .doc(`userTenantMemberships/${claims.uid}_${claims.tenantId}`)
    .get();
  if (!membership.exists || membership.data()?.deletedAt) {
    throw new HttpsError("permission-denied", REMOVED_MEMBER_MESSAGE);
  }
  return { uid: claims.uid, tenantId: claims.tenantId, role: claims.role };
}

/**
 * The platform admin (TechFlow): the `platformAdmin` claim, granted only by
 * scripts/setPlatformAdmin.ts from a trusted machine, on a verified email like
 * every tenant caller (F-02). Platform-admin callables act on a business named
 * in their input rather than one from a tenant claim (D18).
 */
export function requirePlatformAdmin(claims: AuthedClaims): { uid: string } {
  if (!claims.platformAdmin) {
    throw new HttpsError("permission-denied", "Requires the platform admin.");
  }
  if (!claims.emailVerified) {
    throw new HttpsError("failed-precondition", VERIFY_EMAIL_MESSAGE);
  }
  return { uid: claims.uid };
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
