// Callable test harness. Runs handlers directly (no HTTP layer) against the
// live Firestore + Auth emulators. Caller must have `firebase emulators:start`
// running before `npm run test:callables`.

import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import type { CallableRequest } from "firebase-functions/v2/https";

const PROJECT_ID = "techflow-callables-test";

process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
process.env.FIREBASE_STORAGE_EMULATOR_HOST =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? "127.0.0.1:9199";

if (!getApps().length) {
  // storageBucket: logo snapshots (A-06) write to the default bucket.
  initializeApp({
    projectId: PROJECT_ID,
    storageBucket: `${PROJECT_ID}.appspot.com`,
  });
}

export const testDb = getFirestore();
export const testAuth = getAuth();

export interface FakeAuthClaims {
  email?: string;
  email_verified?: boolean;
  tenantId?: string;
  role?: "owner" | "admin" | "staff";
  platformAdmin?: boolean;
}

export function fakeRequest<T>(
  data: T,
  auth: { uid: string; claims?: FakeAuthClaims } | null,
): CallableRequest<T> {
  const request: Partial<CallableRequest<T>> = {
    data,
    rawRequest: {} as never,
    acceptsStreaming: false,
  };
  if (auth) {
    request.auth = {
      uid: auth.uid,
      token: {
        aud: PROJECT_ID,
        auth_time: 0,
        exp: 0,
        firebase: { identities: {}, sign_in_provider: "custom" },
        iat: 0,
        iss: "",
        sub: auth.uid,
        uid: auth.uid,
        ...auth.claims,
      } as never,
    };
  }
  return request as CallableRequest<T>;
}

// D21: requireTenant refuses a caller without an active
// userTenantMemberships/{uid}_{tenantId} document. In production onSignup and
// onAcceptInvite write it before the claims exist. A test file registers the
// tenant users it signs in as (at module level), and clearFirestore() recreates
// their memberships after every wipe, so each test starts from that state.
type MemberRole = "owner" | "admin" | "staff";
const registeredMembers = new Map<
  string,
  { uid: string; tenantId: string; role: MemberRole }
>();

export function registerMembers(
  ...auths: Array<{ uid: string; claims?: FakeAuthClaims }>
): void {
  for (const auth of auths) {
    const tenantId = auth.claims?.tenantId;
    const role = auth.claims?.role;
    if (!tenantId || !role) {
      throw new Error(`registerMembers: ${auth.uid} has no tenant claims`);
    }
    registeredMembers.set(`${auth.uid}_${tenantId}`, {
      uid: auth.uid,
      tenantId,
      role,
    });
  }
}

export function membershipDoc(m: {
  uid: string;
  tenantId: string;
  role: MemberRole;
}) {
  return {
    uid: m.uid,
    tenantId: m.tenantId,
    role: m.role,
    invitedBy: null,
    createdAt: new Date(),
    deletedAt: null,
  };
}

// For a tenant whose id a test only learns at run time (e.g. from onSignup).
export async function seedMembership(
  uid: string,
  tenantId: string,
  role: MemberRole,
): Promise<void> {
  await testDb
    .doc(`userTenantMemberships/${uid}_${tenantId}`)
    .set(membershipDoc({ uid, tenantId, role }));
}

export async function clearFirestore(): Promise<void> {
  const res = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    throw new Error(
      `Failed to clear Firestore emulator: ${res.status} ${res.statusText}`,
    );
  }
  if (registeredMembers.size) {
    const batch = testDb.batch();
    for (const [id, m] of registeredMembers) {
      batch.set(testDb.doc(`userTenantMemberships/${id}`), membershipDoc(m));
    }
    await batch.commit();
  }
}

export async function clearAuthUsers(): Promise<void> {
  const res = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/accounts`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    throw new Error(
      `Failed to clear Auth emulator: ${res.status} ${res.statusText}`,
    );
  }
}

export async function createAuthUser(opts: {
  uid: string;
  email?: string;
  emailVerified?: boolean;
}): Promise<void> {
  await testAuth.createUser({
    uid: opts.uid,
    email: opts.email,
    emailVerified: opts.emailVerified ?? false,
  });
}
