// sendQuoteEmail — Phase 2 Bundle F; transport moved to Amazon SES (D5).
//
// Tenant callable: reads quote doc, renders QuoteSent template, sends via
// emails/send.ts. Transitions status from "draft" to "sent" if currently draft.

import {
  onCall,
  HttpsError,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { createElement } from "react";
import { render } from "@react-email/render";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requireTenant } from "../shared/auth";
import { requireDocId } from "../shared/docId";
import { requireFeature } from "../shared/requireFeature";
import { RATE_LIMITS, enforceRateLimit } from "../shared/rateLimit";
import { withSentryCallable } from "../shared/withSentry";
import { sanitizeEmailField } from "../emails/sanitize";
import { EMAIL_SECRETS, pickReplyTo, sendEmail } from "../emails/send";
import { formatCurrency } from "../emails/format";
import { emailLogoUrl } from "../shared/logo";
import { QuoteSent } from "../emails/templates/QuoteSent";
import type { TenantSnapshotForEmail } from "../emails/components/TenantEmailLayout";

export async function sendQuoteEmailHandler(
  request: CallableRequest,
): Promise<{ success: true }> {
  const claims = readClaims(request);
  const { uid, tenantId } = requireTenant(claims);
  await requireFeature(tenantId, "quotes");
  await enforceRateLimit(uid, RATE_LIMITS.sendEmail);

  const data = request.data as Record<string, unknown> | undefined;
  const quoteId = requireDocId(data?.quoteId, "quoteId");

  // Load quote.
  const quoteRef = db.doc(`tenants/${tenantId}/quotes/${quoteId}`);
  const quoteSnap = await quoteRef.get();
  if (!quoteSnap.exists) {
    throw new HttpsError("not-found", "Quote not found.");
  }
  const quote = quoteSnap.data()!;

  if (!quote.customer?.email) {
    throw new HttpsError(
      "failed-precondition",
      "Quote has no customer email.",
    );
  }

  // S-06: a converted quote has become an invoice; emailing it again would ask
  // the customer to review an offer that has already been invoiced.
  if (quote.status === "converted") {
    throw new HttpsError(
      "failed-precondition",
      "This quote was converted to an invoice, so it can't be sent. Send the invoice instead.",
    );
  }

  // Build email props.
  const snapshot = quote.tenantSnapshot ?? {};
  const tenant: TenantSnapshotForEmail = {
    name: snapshot.name ?? "",
    address: snapshot.address ?? null,
    // A-06: hosted copy, never the base64 logo (Gmail clips emails over 102 KB).
    logoUrl: emailLogoUrl(snapshot),
    emailFooter: snapshot.emailFooter ?? null,
    primaryColor: snapshot.primaryColor ?? null,
  };

  const appUrl =
    process.env.APP_URL || "https://portal.techflowsolutions.ca";
  const totalFormatted = formatCurrency(
    quote.totals?.total ?? 0,
    snapshot.currency ?? "CAD",
  );

  const props = {
    tenant,
    customerFirstName: quote.customer.name?.split(" ")[0] ?? "there",
    quoteNumber: quoteSnap.id,
    totalFormatted,
    validUntilFormatted: quote.validUntil ?? "",
    viewUrl: `${appUrl}/portal/quotes/${quoteSnap.id}?tenantId=${tenantId}`,
  };

  const html = await render(createElement(QuoteSent, props));
  const text = await render(createElement(QuoteSent, props), {
    plainText: true,
  });

  const safeTenantName =
    sanitizeEmailField(snapshot.name, 100) || "TechFlow";

  const metaSnap = await db.doc(`tenants/${tenantId}/meta/settings`).get();
  const meta = metaSnap.exists ? metaSnap.data()! : {};

  await sendEmail({
    to: quote.customer.email,
    subject: `Quote ${quoteSnap.id} from ${safeTenantName} — ${totalFormatted}`,
    html,
    text,
    fromName: safeTenantName,
    replyTo: pickReplyTo(meta.contactEmail, meta.etransferEmail),
    category: "quote",
    tenantId,
    documentId: quoteId,
  });

  // Transition draft → sent.
  if (quote.status === "draft") {
    await quoteRef.update({
      status: "sent",
      sentAt: FieldValue.serverTimestamp(),
    });
  }

  return { success: true };
}

export const sendQuoteEmail = onCall(
  { secrets: EMAIL_SECRETS },
  withSentryCallable("sendQuoteEmail", sendQuoteEmailHandler),
);
