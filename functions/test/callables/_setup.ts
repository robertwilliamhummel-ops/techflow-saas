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

if (!getApps().length) {
  initializeApp({ projectId: PROJECT_ID });
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
