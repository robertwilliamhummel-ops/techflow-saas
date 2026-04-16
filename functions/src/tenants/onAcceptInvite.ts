import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { adminAuth, db, FieldValue } from "../shared/admin";
import { readClaims } from "../shared/auth";
import { lowerEmail } from "../shared/email";
import { hashToken } from "../shared/tokens";

interface Input {
  tenantId?: unknown;
  invitationId?: unknown;
  token?: unknown;
}

export async function onAcceptInviteHandler(
  request: CallableRequest<Input>,
): Promise<{ tenantId: string; role: "owner" | "admin" | "staff" }> {
  const claims = readClaims(request);
  if (!claims.email || !claims.emailVerified) {
    throw new HttpsError(
      "failed-precondition",
      "Verify your email before accepting an invitation.",
    );
  }
  const callerEmail = lowerEmail(claims.email);

  const data = (request.data as Input | undefined) ?? {};
  const tenantId = String(data.tenantId ?? "").trim();
  const invitationId = String(data.invitationId ?? "").trim();
  const rawToken = String(data.token ?? "");
  if (!tenantId || !invitationId || !rawToken) {
    throw new HttpsError(
      "invalid-argument",
      "tenantId, invitationId, and token are all required.",
    );
  }

  // MVP constraint: one active tenant per user. Schema supports multi-tenant
  // memberships from day one; reject here until a "switch active tenant" UI
  // ships post-MVP.
  if (claims.tenantId) {
    throw new HttpsError(
      "already-exists",
      "This account already belongs to a tenant. Multi-tenant membership is post-MVP.",
    );
  }

  const invitationRef = db.doc(
    `tenants/${tenantId}/invitations/${invitationId}`,
  );

  // Atomic read-and-claim. Two invitees racing on the same link must not both
  // succeed. Claim acceptance in the same transaction that validates the token.
  const acceptedRole = await db.runTransaction(async (tx) => {
    const snap = await tx.get(invitationRef);
    if (!snap.exists) {
      throw new HttpsError("not-found", "Invitation not found.");
    }
    const inv = snap.data() as {
      email: string;
      role: "owner" | "admin" | "staff";
      tokenHash: string;
      expiresAt: FirebaseFirestore.Timestamp;
      acceptedAt: unknown;
      revokedAt: unknown;
      invitedBy: string | null;
    };

    if (inv.acceptedAt) {
      throw new HttpsError(
        "failed-precondition",
        "This invitation has already been accepted.",
      );
    }
    if (inv.revokedAt) {
      throw new HttpsError(
        "failed-precondition",
        "This invitation has been revoked.",
      );
    }
    if (inv.expiresAt.toMillis() < Date.now()) {
      throw new HttpsError(
        "deadline-exceeded",
        "This invitation has expired.",
      );
    }
    if (inv.email !== callerEmail) {
      throw new HttpsError(
        "permission-denied",
        "This invitation was issued to a different email address.",
      );
    }
    if (hashToken(rawToken) !== inv.tokenHash) {
      throw new HttpsError("permission-denied", "Invalid invitation token.");
    }

    tx.update(invitationRef, {
      acceptedAt: FieldValue.serverTimestamp(),
      acceptedBy: claims.uid,
    });
    tx.set(db.doc(`userTenantMemberships/${claims.uid}_${tenantId}`), {
      uid: claims.uid,
      tenantId,
      role: inv.role,
      invitedBy: inv.invitedBy,
      createdAt: FieldValue.serverTimestamp(),
      deletedAt: null,
    });
    tx.set(
      db.doc(`users/${claims.uid}`),
      {
        uid: claims.uid,
        email: callerEmail,
        displayName: null,
        defaultTenantId: tenantId,
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return inv.role;
  });

  const existing = (await adminAuth.getUser(claims.uid)).customClaims ?? {};
  await adminAuth.setCustomUserClaims(claims.uid, {
    ...existing,
    tenantId,
    role: acceptedRole,
  });

  return { tenantId, role: acceptedRole };
}

export const onAcceptInvite = onCall<Input>(onAcceptInviteHandler);
