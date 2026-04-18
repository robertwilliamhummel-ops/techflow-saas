import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

function getOrCreateApp(): FirebaseApp {
  if (getApps().length) return getApp();
  return initializeApp(firebaseConfig);
}

// Lazy init — avoid crashing during next build when env vars are absent.
let _app: FirebaseApp | undefined;
let _auth: Auth | undefined;
let _db: Firestore | undefined;

export function getClientApp(): FirebaseApp {
  if (!_app) _app = getOrCreateApp();
  return _app;
}

/** Firebase Auth instance. Throws at runtime if env vars are missing. */
export function getClientAuth(): Auth {
  if (!_auth) _auth = getAuth(getClientApp());
  return _auth;
}

/** Firestore instance. Throws at runtime if env vars are missing. */
export function getClientDb(): Firestore {
  if (!_db) _db = getFirestore(getClientApp());
  return _db;
}
