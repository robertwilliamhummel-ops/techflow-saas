import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requireRole, requireTenant } from "../shared/auth";

interface Input {
  invitationId?: unknown;
}

// Owner/admin can revoke a pending invitation. Stamps `revokedAt` rather than
// deleting so the audit trail (who invited, when, who revoked) survives.
// Already-accepted invites are immutable; remove the user via setUserRole or
// disable in Firebase Auth instead.
export async function revokeInvitationHandler(
  request: CallableRequest<Input>,
): Promise<{ ok: true }> {
  const claims = readClaims(request);
  const { tenantId, uid } = requireTenant(claims);
  requireRole(claims, ["owner", "admin"]);

  const invitationId = String(
    (request.data as Input | undefined)?.invitationId ?? "",
  ).trim();
  if (!invitationId) {
    throw new HttpsError("invalid-argument", "invitationId is required.");
  }

  const ref = db.doc(`tenants/${tenantId}/invitations/${invitationId}`);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError("not-found", "Invitation not found.");
    }
    const inv = snap.data() as {
      acceptedAt: unknown;
      revokedAt: unknown;
    };
    if (inv.acceptedAt) {
      throw new HttpsError(
        "failed-precondition",
        "Invitation already accepted — remove the member instead.",
      );
    }
    if (inv.revokedAt) {
      throw new HttpsError(
        "failed-precondition",
        "Invitation already revoked.",
      );
    }
    tx.update(ref, {
      revokedAt: FieldValue.serverTimestamp(),
      revokedBy: uid,
    });
  });

  return { ok: true };
}

export const revokeInvitation = onCall<Input>(revokeInvitationHandler);
