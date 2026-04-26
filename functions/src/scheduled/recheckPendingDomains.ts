// recheckPendingDomains — Phase 5 Bundle E.
//
// Walks every tenant whose customDomainStatus.stage is dns_pending or
// ssl_pending and asks Vercel for current state. The single-tenant logic
// lives in domain/setupCustomDomain.ts so the manual "Re-check now" button
// and this cron use the same code path.
//
// Runs every 5 minutes. Skipped tenants (verified / unverified / error >24h
// stale) are not queried — keeps the Vercel API call count bounded by the
// number of in-flight provisioning operations, not the total tenant count.

import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { db } from "../shared/admin";
import { checkAndUpdateDomainStatus } from "../domain/setupCustomDomain";
import { VERCEL_SECRETS } from "../shared/vercel";

export async function recheckPendingDomainsHandler(): Promise<void> {
  // Collection-group query across every tenant's meta/settings doc filtered
  // by status stage. Indexed via firestore.indexes.json.
  const snap = await db
    .collectionGroup("meta")
    .where("customDomainStatus.stage", "in", ["dns_pending", "ssl_pending"])
    .get();

  if (snap.empty) {
    logger.info("recheckPendingDomains: nothing pending");
    return;
  }

  for (const doc of snap.docs) {
    const data = doc.data() as { customDomain?: string | null };
    const domain = data.customDomain ?? null;
    if (!domain) continue;
    // tenants/{tenantId}/meta/settings → segments[1] is the tenantId.
    const tenantId = doc.ref.parent.parent?.id;
    if (!tenantId) continue;
    try {
      const result = await checkAndUpdateDomainStatus(tenantId, domain);
      logger.info("recheckPendingDomains: updated", {
        tenantId,
        domain,
        stage: result.stage,
      });
    } catch (err) {
      logger.error("recheckPendingDomains: tenant check failed", {
        tenantId,
        domain,
        err,
      });
    }
  }
}

export const recheckPendingDomains = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "UTC",
    region: "us-central1",
    secrets: [...VERCEL_SECRETS],
  },
  recheckPendingDomainsHandler,
);
