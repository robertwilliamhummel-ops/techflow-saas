// Region placement (decision D2, 2026-09-13).
//
// Firestore (default) lives in northamerica-northeast2 (Toronto). Every
// callable, HTTP function, and Firestore trigger runs next to it — Firestore
// triggers MUST share the database's region (Eventarc requirement).
//
// Cloud Scheduler is not offered in Toronto, so scheduled functions pin to
// northamerica-northeast1 (Montréal), the other Canadian region.
//
// This module must be the FIRST import in src/index.ts: firebase-functions
// captures global options when each function is defined, so any function
// module imported before setGlobalOptions runs would deploy to us-central1.

import { setGlobalOptions } from "firebase-functions/v2";

export const FUNCTIONS_REGION = "northamerica-northeast2";
export const SCHEDULER_REGION = "northamerica-northeast1";

setGlobalOptions({ region: FUNCTIONS_REGION });
