// removeMember (D21) — an owner takes a teammate's access away.
//
// Owner-only. The target must be an admin or staff member of the caller's
// business: an owner can't remove themselves or another owner (change their
// role first with setUserRole), so every business keeps at least one owner.
//
// In order:
//   1. The membership is marked deleted (deletedAt, deletedBy) in a transaction,
//      and users/{uid}.defaultTenantId is cleared if it pointed here. From this
//      moment requireTenant refuses the member's every callable, even with an
//      ID token minted before the removal.
//   2. Their tenantId and role claims are cleared (other claims are kept), so a
//      fresh token carries no tenant.
//   3. Their refresh tokens are revoked, so no device can mint a new ID token.
//      An ID token already issued stays valid for up to an hour; callables
//      refuse it (step 1), while Firestore rules — which check only the claim —
//      still allow reads with it until it expires.
//
// A repeat call for a member already removed re-applies steps 2 and 3, so a
// removal whose claims or revocation step failed can be finished by retrying.

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { adminAuth, db, FieldValue } from "../shared/admin";
import { readClaims, requireRole, requireTenant } from "../shared/auth";
import { requireDocId } from "../shared/docId";
import { withSentryCallable } from "../shared/withSentry";

interface Input {
  targetUid?: unknown;
}

const REMOVABLE_ROLES: ReadonlySet<unknown> = new Set(["admin", "staff"]);

export async function removeMemberHandler(
  request: CallableRequest<Input>,
): Promise<{ ok: true }> {
  const claims = readClaims(request);
  const { uid, tenantId } = await requireTenant(claims);
  requireRole(claims, ["owner"]);

  const targetUid = requireDocId(
    (request.data as Input | undefined)?.targetUid,
    "targetUid",
  );
  if (targetUid === uid) {
    throw new HttpsError(
      "failed-precondition",
      "You can't remove yourself from your business.",
    );
  }

  const membershipRef = db.doc(`userTenantMemberships/${targetUid}_${tenantId}`);
  const userRef = db.doc(`users/${targetUid}`);
  await db.runTransaction(async (tx) => {
    const [membership, user] = await Promise.all([
      tx.get(membershipRef),
      tx.get(userRef),
    ]);
    const data = membership.data() as
      | { role?: unknown; deletedAt?: unknown }
      | undefined;
    if (!membership.exists || !data) {
      throw new HttpsError("not-found", "That person isn't on your team.");
    }
    if (!REMOVABLE_ROLES.has(data.role)) {
      throw new HttpsError(
        "failed-precondition",
        "Owners can't be removed. Change their role first.",
      );
    }
    if (!data.deletedAt) {
      tx.update(membershipRef, {
        deletedAt: FieldValue.serverTimestamp(),
        deletedBy: uid,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    if (user.data()?.defaultTenantId === tenantId) {
      tx.update(userRef, {
        defaultTenantId: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });

  // The Auth account may already be gone (deleted in the Console); the
  // membership is what callables check, so that's not an error.
  let existing: Record<string, unknown>;
  try {
    existing = (await adminAuth.getUser(targetUid)).customClaims ?? {};
  } catch (err) {
    if ((err as { code?: string }).code === "auth/user-not-found") {
      return { ok: true };
    }
    throw err;
  }
  if (existing.tenantId === tenantId) {
    const rest = { ...existing };
    delete rest.tenantId;
    delete rest.role;
    await adminAuth.setCustomUserClaims(targetUid, rest);
  }
  await adminAuth.revokeRefreshTokens(targetUid);

  return { ok: true };
}

export const removeMember = onCall<Input>(
  withSentryCallable("removeMember", removeMemberHandler),
);
