import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { adminAuth, db, FieldValue } from "../shared/admin";
import { readClaims, requireRole, requireTenant } from "../shared/auth";
import type { MembershipRole } from "../shared/auth";

interface Input {
  targetUid?: unknown;
  role?: unknown;
}

const ALLOWED_ROLES: readonly MembershipRole[] = ["owner", "admin", "staff"];

function validRole(v: unknown): MembershipRole {
  if (v === "owner" || v === "admin" || v === "staff") return v;
  throw new HttpsError(
    "invalid-argument",
    `role must be one of: ${ALLOWED_ROLES.join(", ")}.`,
  );
}

// Owner-only. Changes a fellow tenant member's role + membership doc.
// Target user's ID token stays stale until they refresh — see blueprint.
export async function setUserRoleHandler(
  request: CallableRequest<Input>,
): Promise<{ ok: true }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  requireRole(claims, ["owner"]);

  const targetUid = String((request.data as Input | undefined)?.targetUid ?? "");
  const nextRole = validRole((request.data as Input | undefined)?.role);
  if (!targetUid) {
    throw new HttpsError("invalid-argument", "targetUid is required.");
  }
  if (targetUid === claims.uid) {
    throw new HttpsError(
      "failed-precondition",
      "Owners cannot change their own role. Transfer ownership first.",
    );
  }

  const membershipRef = db.doc(
    `userTenantMemberships/${targetUid}_${tenantId}`,
  );
  const snap = await membershipRef.get();
  if (!snap.exists || (snap.data() as { deletedAt?: unknown })?.deletedAt) {
    throw new HttpsError(
      "not-found",
      "Target user is not an active member of this tenant.",
    );
  }

  await membershipRef.update({
    role: nextRole,
    updatedAt: FieldValue.serverTimestamp(),
  });

  const existing = (await adminAuth.getUser(targetUid)).customClaims ?? {};
  // Only rewrite claims if the target's active tenant is this one.
  if ((existing as { tenantId?: string }).tenantId === tenantId) {
    await adminAuth.setCustomUserClaims(targetUid, {
      ...existing,
      role: nextRole,
    });
  }

  return { ok: true };
}

export const setUserRole = onCall<Input>(setUserRoleHandler);
