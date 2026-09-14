import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "firebase/app-check";
import { getAuth, connectAuthEmulator, type Auth } from "firebase/auth";
import {
  getFirestore,
  connectFirestoreEmulator,
  type Firestore,
} from "firebase/firestore";
import {
  getFunctions,
  connectFunctionsEmulator,
  type Functions,
} from "firebase/functions";
import {
  getStorage,
  connectStorageEmulator,
  type FirebaseStorage,
} from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const USE_EMULATORS = process.env.NEXT_PUBLIC_USE_EMULATORS === "1";

// Callable region — must match functions/src/shared/globalOptions.ts (D2).
const FUNCTIONS_REGION =
  process.env.NEXT_PUBLIC_FIREBASE_FUNCTIONS_REGION ?? "northamerica-northeast2";

function getOrCreateApp(): FirebaseApp {
  if (getApps().length) return getApp();
  const app = initializeApp(firebaseConfig);
  startAppCheck(app);
  return app;
}

/**
 * App Check (R-04): attests that requests come from this web app, so Cloud
 * Functions can reject everything else once ENFORCE_APP_CHECK is on. Runs in
 * the browser only, and only when the reCAPTCHA Enterprise site key is set.
 * The Functions client attaches the token to every callable automatically.
 */
export function startAppCheck(app: FirebaseApp): boolean {
  const siteKey = process.env.NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY;
  if (typeof window === "undefined" || !siteKey) return false;

  // A debug token lets localhost and CI through enforcement. Firebase warns a
  // leaked debug token opens the backend to anyone, so a production build
  // never uses one, even if the variable is set.
  const debugToken = process.env.NEXT_PUBLIC_APP_CHECK_DEBUG_TOKEN;
  if (debugToken && process.env.NODE_ENV !== "production") {
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean })
      .FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken === "true" ? true : debugToken;
  }

  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(siteKey),
    isTokenAutoRefreshEnabled: true,
  });
  return true;
}

// Lazy init — avoid crashing during next build when env vars are absent.
let _app: FirebaseApp | undefined;
let _auth: Auth | undefined;
let _db: Firestore | undefined;
let _functions: Functions | undefined;
let _storage: FirebaseStorage | undefined;

export function getClientApp(): FirebaseApp {
  if (!_app) _app = getOrCreateApp();
  return _app;
}

/** Firebase Auth instance. Throws at runtime if env vars are missing. */
export function getClientAuth(): Auth {
  if (!_auth) {
    _auth = getAuth(getClientApp());
    if (USE_EMULATORS) {
      connectAuthEmulator(_auth, "http://127.0.0.1:9099", {
        disableWarnings: true,
      });
    }
  }
  return _auth;
}

/** Firestore instance. Throws at runtime if env vars are missing. */
export function getClientDb(): Firestore {
  if (!_db) {
    _db = getFirestore(getClientApp());
    if (USE_EMULATORS) {
      connectFirestoreEmulator(_db, "127.0.0.1", 8080);
    }
  }
  return _db;
}

/** Cloud Functions client, pinned to the Toronto callable region (D2). */
export function getClientFunctions(): Functions {
  if (!_functions) {
    _functions = getFunctions(getClientApp(), FUNCTIONS_REGION);
    if (USE_EMULATORS) {
      connectFunctionsEmulator(_functions, "127.0.0.1", 5001);
    }
  }
  return _functions;
}

/** Firebase Storage instance. */
export function getClientStorage(): FirebaseStorage {
  if (!_storage) {
    _storage = getStorage(getClientApp());
    if (USE_EMULATORS) {
      connectStorageEmulator(_storage, "127.0.0.1", 9199);
    }
  }
  return _storage;
}
