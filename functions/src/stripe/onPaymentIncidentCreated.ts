// onPaymentIncidentCreated — decision D5.
//
// The Stripe Connect webhook (Next.js) writes paymentIncidents audit docs with
// deterministic ids; this Firestore trigger emails every active tenant owner.
// Moving the send here keeps all email in Cloud Functions behind one SES
// credential, and a webhook redelivery rewrites the same doc (an update, not a
// create), so owners are never emailed twice for one incident.

import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import { db } from "../shared/admin";
import { EMAIL_SECRETS, sendEmail } from "../emails/send";
import { withSentryEvent } from "../shared/withSentry";
import {
  buildPaymentIncidentEmail,
  isNotifiableIncidentKind,
} from "../emails/paymentIncident";

export async function handlePaymentIncidentCreated(params: {
  tenantId: string;
  invoiceId: string;
  incidentId: string;
  incident: Record<string, unknown>;
}): Promise<{ sent: number }> {
  const { tenantId, invoiceId, incidentId, incident } = params;
  const kind = incident.kind;
  if (!isNotifiableIncidentKind(kind)) {
    // e.g. tenant-mismatch — a platform bug, surfaced in logs, not to owners.
    logger.info("paymentIncident: not owner-notifiable", {
      tenantId,
      invoiceId,
      incidentId,
      kind,
    });
    return { sent: 0 };
  }

  const metaSnap = await db.doc(`tenants/${tenantId}/meta/settings`).get();
  const tenantName =
    (metaSnap.data()?.name as string | undefined)?.trim() || "your business";

  const memberships = await db
    .collection("userTenantMemberships")
    .where("tenantId", "==", tenantId)
    .where("role", "==", "owner")
    .get();

  const email = buildPaymentIncidentEmail(kind, {
    tenantName,
    invoiceId,
    incident,
  });

  let sent = 0;
  for (const membership of memberships.docs) {
    const m = membership.data() as { uid?: string; deletedAt?: unknown };
    if (!m.uid || m.deletedAt) continue;
    const userSnap = await db.doc(`users/${m.uid}`).get();
    const to = userSnap.data()?.email;
    if (typeof to !== "string" || !to.includes("@")) continue;
    try {
      const result = await sendEmail({
        to,
        subject: email.subject,
        text: email.text,
        html: email.html,
        fromName: "TechFlow",
        category: "payment-incident",
        tenantId,
        documentId: invoiceId,
        idempotencyKey: `incident:${tenantId}:${invoiceId}:${incidentId}:${m.uid}`,
      });
      if (!result.deduplicated) sent += 1;
    } catch (err) {
      // One owner's failure must not block the others; the audit doc remains
      // the load-bearing record.
      logger.error("paymentIncident: owner email failed", {
        tenantId,
        invoiceId,
        incidentId,
        uid: m.uid,
        error: String(err),
      });
    }
  }
  return { sent };
}

export const onPaymentIncidentCreated = onDocumentCreated(
  {
    document:
      "tenants/{tenantId}/invoices/{invoiceId}/paymentIncidents/{incidentId}",
    secrets: EMAIL_SECRETS,
  },
  withSentryEvent("onPaymentIncidentCreated", async (event) => {
    const incident = event.data?.data();
    if (!incident) return;
    await handlePaymentIncidentCreated({
      tenantId: event.params.tenantId,
      invoiceId: event.params.invoiceId,
      incidentId: event.params.incidentId,
      incident,
    });
  }),
);
