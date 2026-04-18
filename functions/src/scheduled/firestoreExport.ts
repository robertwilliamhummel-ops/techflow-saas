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

export async function scheduledFirestoreExportHandler(): Promise<void> {
  const firestore = google.firestore("v1");
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
  { schedule: "every day 03:00", timeZone: "UTC", region: "us-central1" },
  scheduledFirestoreExportHandler,
);
