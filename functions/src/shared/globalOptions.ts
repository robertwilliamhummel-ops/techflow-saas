// Region placement (decision D2, 2026-09-13).
//
// Firestore (default) lives in northamerica-northeast2 (Toronto). Every
// callable, HTTP function, and Firestore trigger runs next to it — Firestore
// triggers MUST share the database's region (Eventarc requirement).
//
// Cloud Scheduler is not offered in Toronto, so scheduled functions pin to
// northamerica-northeast1 (Montréal), the other Canadian region.
//
// src/index.ts must import this module before any function module (only
// shared/sentry.ts, which defines no functions, comes earlier):
// firebase-functions captures global options when each function is defined,
// so a function module imported before setGlobalOptions runs would deploy to
// us-central1.

import { setGlobalOptions } from "firebase-functions/v2";

export const FUNCTIONS_REGION = "northamerica-northeast2";
export const SCHEDULER_REGION = "northamerica-northeast1";

// App Check (R-04). With ENFORCE_APP_CHECK=true in functions/.env.<projectId>,
// every callable rejects requests without a valid App Check token (401).
// Leave it off until the web app is registered in App Check with a reCAPTCHA
// Enterprise key and the App Check metrics show the app's own traffic passing;
// turning it on earlier rejects every call. Callables read this default when
// they're defined; Firestore, scheduled, and HTTP-request functions ignore it.
export const ENFORCE_APP_CHECK = process.env.ENFORCE_APP_CHECK === "true";

setGlobalOptions({
  region: FUNCTIONS_REGION,
  enforceAppCheck: ENFORCE_APP_CHECK,
});
