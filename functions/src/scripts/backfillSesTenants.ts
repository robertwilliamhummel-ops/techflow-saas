// One-shot (D22): creates the SES tenant for every existing business, with the
// identity and this environment's configuration set associated and a
// tenant-scoped suppression list. Idempotent — rerun it as often as needed.
//
// Run once per environment from a trusted machine, BEFORE setting
// SES_TENANTS_ENABLED=true (onSignup covers businesses created afterwards):
//
//   GOOGLE_APPLICATION_CREDENTIALS=<service-account.json> \
//   AWS_PROFILE=techflow SES_CONFIGURATION_SET=<the environment's set> \
//   npx ts-node src/scripts/backfillSesTenants.ts <projectId> [--dry-run]
//
// AWS credentials come from the default provider chain (AWS_PROFILE), not the
// functions' sending key. SES_REGION and EMAIL_FROM_ADDRESS default as in
// send.ts (us-east-1, notifications@techflowsolutions.ca).

import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import {
  ensureSesTenant,
  sesConfigurationSetArn,
  sesIdentityArn,
  sesTenantName,
} from "../emails/sesTenants";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const projectId = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (!projectId) {
    console.error("Usage: backfillSesTenants <projectId> [--dry-run]");
    process.exit(1);
  }
  if (!process.env.SES_CONFIGURATION_SET) {
    console.error(
      "Set SES_CONFIGURATION_SET to this environment's configuration set (D12) first.",
    );
    process.exit(1);
  }

  if (!getApps().length) {
    initializeApp({ credential: applicationDefault(), projectId });
  }
  const db = getFirestore();
  const ses = new SESv2Client({ region: process.env.SES_REGION || "us-east-1" });

  console.log(`Project ${projectId}${dryRun ? " (dry run)" : ""}`);
  console.log(`  identity:          ${sesIdentityArn()}`);
  console.log(`  configuration set: ${sesConfigurationSetArn()}`);

  // tenants/{id} has no fields of its own; a business is one with settings.
  const refs = await db.collection("tenants").listDocuments();
  const settings = refs.length
    ? await db.getAll(...refs.map((r) => r.collection("meta").doc("settings")))
    : [];
  const tenantIds = settings
    .filter((s) => s.exists)
    .map((s) => s.ref.parent.parent!.id)
    .sort();

  let failed = 0;
  for (const tenantId of tenantIds) {
    if (dryRun) {
      console.log(`  would ensure ${sesTenantName(tenantId)}`);
      continue;
    }
    try {
      await ensureSesTenant(tenantId, ses);
      console.log(`  ok    ${sesTenantName(tenantId)}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL  ${sesTenantName(tenantId)}: ${String(err)}`);
    }
  }
  console.log(`${tenantIds.length} businesses, ${failed} failed.`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
