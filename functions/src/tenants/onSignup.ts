import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { adminAuth, db, FieldValue } from "../shared/admin";
import { lowerEmail } from "../shared/email";
import { pickTenantId } from "../shared/tenantId";
import { defaultTenantMeta } from "../shared/meta";
import { withSentryCallable } from "../shared/withSentry";

interface SignupInput {
  businessName?: unknown;
}

// gRPC ALREADY_EXISTS: a tx.create() lost a race. Firestore's transaction
// runner retries only ABORTED and transient codes, so this one is retried here.
const ALREADY_EXISTS = 6;
const MAX_ATTEMPTS = 3;

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
//
// A-12: one transaction checks and claims everything. `signups/{uid}` and every
// tenant document are written with create(), which fails if the document
// already exists, so a double submit can't create two tenants and two
// businesses with the same name can't end up sharing (and overwriting) one
// tenant id — the second commit fails, is retried, and sees the first one's
// documents. A repeat call after a successful signup returns the same tenant
// and re-applies the claims, so a signup whose claims write failed recovers.
export async function onSignupHandler(
  request: CallableRequest<SignupInput>,
): Promise<{ tenantId: string }> {
  const auth = request.auth;
  if (!auth) {
    throw new HttpsError("unauthenticated", "Sign in required before signup.");
  }
  const uid = auth.uid;
  const token = auth.token as { email?: unknown; tenantId?: unknown };
  const email = lowerEmail(token.email);
  if (!email) {
    throw new HttpsError(
      "failed-precondition",
      "Auth account is missing an email address.",
    );
  }
  if (typeof token.tenantId === "string") {
    throw new HttpsError(
      "already-exists",
      "This user is already a member of a tenant.",
    );
  }

  const businessName = validateBusinessName(
    (request.data as SignupInput | undefined)?.businessName,
  );

  const { tenantId, role } = await claimTenantWithRetry(
    uid,
    email,
    businessName,
  );

  // Custom claims set AFTER Firestore so a partial failure doesn't leave a
  // user with tenant claims pointing at a tenant that doesn't exist.
  const existing = (await adminAuth.getUser(uid)).customClaims ?? {};
  await adminAuth.setCustomUserClaims(uid, {
    ...existing,
    tenantId,
    role,
  });

  return { tenantId };
}

async function claimTenantWithRetry(
  uid: string,
  email: string,
  businessName: string,
): Promise<{ tenantId: string; role: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.runTransaction((tx) =>
        claimTenant(tx, uid, email, businessName),
      );
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (attempt < MAX_ATTEMPTS && code === ALREADY_EXISTS) continue;
      throw err;
    }
  }
}

async function claimTenant(
  tx: FirebaseFirestore.Transaction,
  uid: string,
  email: string,
  businessName: string,
): Promise<{ tenantId: string; role: string }> {
  const signupRef = db.doc(`signups/${uid}`);
  const signup = await tx.get(signupRef);
  if (signup.exists) {
    // Repeat call — same tenant; the caller re-applies the claims.
    const tenantId = String(signup.data()!.tenantId);
    const membership = await tx.get(
      db.doc(`userTenantMemberships/${uid}_${tenantId}`),
    );
    const role = membership.data()?.role;
    if (!membership.exists || membership.data()?.deletedAt || typeof role !== "string") {
      throw new HttpsError(
        "failed-precondition",
        "This account's earlier signup can't be restored. Contact support.",
      );
    }
    return { tenantId, role };
  }

  // Invited members have a membership but never signed up.
  const memberships = await tx.get(
    db.collection("userTenantMemberships").where("uid", "==", uid).limit(1),
  );
  if (!memberships.empty) {
    throw new HttpsError(
      "already-exists",
      "This user is already a member of a tenant.",
    );
  }

  // May already exist — updateUserProfile can create it before signup.
  const userRef = db.doc(`users/${uid}`);
  const user = await tx.get(userRef);

  const tenantId = await pickTenantId(tx, businessName);

  tx.create(signupRef, {
    uid,
    tenantId,
    createdAt: FieldValue.serverTimestamp(),
  });
  tx.create(
    db.doc(`tenants/${tenantId}/meta/settings`),
    defaultTenantMeta(businessName, email),
  );
  tx.create(db.doc(`tenants/${tenantId}/entitlements/current`), {
    plan: "starter",
    // D9: no usage limits. The field stays so paid plans can set one later.
    maxInvoicesPerMonth: null,
    features: {}, // resolve via FEATURE_DEFAULTS until platform admin overrides
    updatedAt: FieldValue.serverTimestamp(),
  });
  tx.create(db.doc(`tenants/${tenantId}/counters/invoice`), {
    value: 0,
    updatedAt: FieldValue.serverTimestamp(),
  });
  tx.create(db.doc(`tenants/${tenantId}/counters/quote`), {
    value: 0,
    updatedAt: FieldValue.serverTimestamp(),
  });
  tx.set(
    userRef,
    {
      uid,
      email,
      displayName: user.data()?.displayName ?? null,
      defaultTenantId: tenantId,
      createdAt: user.data()?.createdAt ?? FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  tx.create(db.doc(`userTenantMemberships/${uid}_${tenantId}`), {
    uid,
    tenantId,
    role: "owner",
    invitedBy: null,
    createdAt: FieldValue.serverTimestamp(),
    deletedAt: null,
  });

  return { tenantId, role: "owner" };
}

export const onSignup = onCall<SignupInput>(
  withSentryCallable("onSignup", onSignupHandler),
);
