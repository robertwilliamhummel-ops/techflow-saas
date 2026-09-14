// Sentry for Cloud Functions (O-01).
//
// Imported first in src/index.ts, before firebase-functions, as Sentry's setup
// guide asks. SENTRY_DSN in functions/.env.<projectId> turns reporting on;
// without it nothing is sent, so emulator runs and tests stay quiet. Each
// environment has its own Sentry project, so the environment name is the
// Firebase project id.
//
// Sentry's automatic Firebase integration only instruments firebase-functions
// below 7 (we run 7), so functions report errors explicitly through the
// withSentry* wrappers in withSentry.ts. Errors only — no performance tracing
// and no default PII; events carry the uid, never an email address.

import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN || undefined;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment:
    process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "local",
  sendDefaultPii: false,
});
