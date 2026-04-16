import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { adminAuth, db, FieldValue } from "../shared/admin";
import { lowerEmail } from "../shared/email";
import { generateTenantId } from "../shared/tenantId";
import { defaultTenantMeta } from "../shared/meta";

interface SignupInput {
  businessName?: unknown;
}

function validateBusinessName(input: unknown): string {
  const name = String(input ?? "").trim();
  if (name.length < 2 || name.length > 100) {
    throw new HttpsError(
      "invalid-argument",
      "businessName must be 2–100 characters.",
    );
  }
  return name;
}

// Callable (not an Auth onCreate trigger) — see blueprint Phase 5.
// Client creates the Firebase Auth user first, then awaits this call, then
// calls `user.getIdToken(true)` to pull the freshly-set custom claims.
export async function onSignupHandler(
  request: CallableRequest<SignupInput>,
): Promise<{ tenantId: string }> {
  const auth = request.auth;
  if (!auth) {
    throw new HttpsError("unauthenticated", "Sign in required before signup.");
  }
  const uid = auth.uid;
  const rawEmail = (auth.token as { email?: unknown }).email;
  const email = lowerEmail(rawEmail);
  if (!email) {
    throw new HttpsError(
      "failed-precondition",
      "Auth account is missing an email address.",
    );
  }

  // Reject if this user already owns a tenant (defensive — the client should
  // be gating this, but a retry after a flaky network must not create two).
  const existingMembership = await db
    .collection("userTenantMemberships")
    .where("uid", "==", uid)
    .limit(1)
    .get();
  if (!existingMembership.empty) {
    throw new HttpsError(
      "already-exists",
      "This user is already a member of a tenant.",
    );
  }

  const businessName = validateBusinessName(
    (request.data as SignupInput | undefined)?.businessName,
  );

  const tenantId = await generateTenantId(businessName);

  // Batched writes: meta, entitlements, both counters, user, membership.
  const batch = db.batch();
  batch.set(
    db.doc(`tenants/${tenantId}/meta/settings`),
    defaultTenantMeta(businessName),
  );
  batch.set(db.doc(`tenants/${tenantId}/entitlements/current`), {
    plan: "starter",
    maxInvoicesPerMonth: 10,
    features: {}, // resolve via FEATURE_DEFAULTS until platform admin overrides
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.doc(`tenants/${tenantId}/counters/invoice`), {
    value: 0,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.doc(`tenants/${tenantId}/counters/quote`), {
    value: 0,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.doc(`users/${uid}`), {
    uid,
    email,
    displayName: null,
    defaultTenantId: tenantId,
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.doc(`userTenantMemberships/${uid}_${tenantId}`), {
    uid,
    tenantId,
    role: "owner",
    invitedBy: null,
    createdAt: FieldValue.serverTimestamp(),
    deletedAt: null,
  });
  await batch.commit();

  // Custom claims set AFTER Firestore so a partial failure doesn't leave a
  // user with tenant claims pointing at a tenant that doesn't exist.
  const existing = (await adminAuth.getUser(uid)).customClaims ?? {};
  await adminAuth.setCustomUserClaims(uid, {
    ...existing,
    tenantId,
    role: "owner",
  });

  return { tenantId };
}

export const onSignup = onCall<SignupInput>(onSignupHandler);
