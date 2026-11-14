// scheduledFirestoreExport — Phase 2 Bundle H.
//
// Daily managed Firestore export to Cloud Storage. Runs at 03:00 UTC
// (low-traffic window). Destination: gs://{projectId}-firestore-backups/daily/{YYYY-MM-DD}/.
//
// Blueprint "Firestore Backup Strategy" lines 2401–2425.
// Bucket lifecycle rule (30-day deletion) is set in GCS console, not here.

import { onSchedule } from "firebase-functions/v2/scheduler";
import { google } from "googleapis";
import * as logger from "firebase-functions/logger";
import { SCHEDULER_REGION } from "../shared/globalOptions";
import { withSentryEvent } from "../shared/withSentry";

// googleapis clients don't pick up the runtime's credentials by themselves:
// without `auth` the request goes out unauthenticated and Google rejects it
// ("Request is missing required authentication credential"). Every nightly
// export on staging failed that way until this fix (2026-11-14). GoogleAuth
// uses the function's service account, which holds
// roles/datastore.importExportAdmin (Deploy Runbook step 1).
const EXPORT_SCOPES = [
  "https://www.googleapis.com/auth/datastore",
  "https://www.googleapis.com/auth/cloud-platform",
];

export async function scheduledFirestoreExportHandler(): Promise<void> {
  const auth = new google.auth.GoogleAuth({ scopes: EXPORT_SCOPES });
  const firestore = google.firestore({ version: "v1", auth });
  const projectId = process.env.GCLOUD_PROJECT!;
  const bucket = `gs://${projectId}-firestore-backups`;
  const timestamp = new Date().toISOString().slice(0, 10);
  const outputUriPrefix = `${bucket}/daily/${timestamp}`;

  logger.info("scheduledFirestoreExport: starting", {
    projectId,
    outputUriPrefix,
  });

  await firestore.projects.databases.exportDocuments({
    name: `projects/${projectId}/databases/(default)`,
    requestBody: {
      outputUriPrefix,
      // collectionIds: []  // empty = export all collections
    },
  });

  logger.info("scheduledFirestoreExport: complete", { outputUriPrefix });
}

export const scheduledFirestoreExport = onSchedule(
  { schedule: "every day 03:00", timeZone: "UTC", region: SCHEDULER_REGION },
  withSentryEvent("scheduledFirestoreExport", scheduledFirestoreExportHandler),
);
