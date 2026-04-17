// sendQuoteEmail — Phase 2 Bundle F.
//
// Tenant callable: reads quote doc, renders QuoteSent template, sends
// via Resend. Transitions status from "draft" to "sent" if currently draft.

import {
  onCall,
  HttpsError,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { createElement } from "react";
import { render } from "@react-email/render";
import { Resend } from "resend";
import * as logger from "firebase-functions/logger";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requireTenant } from "../shared/auth";
import { requireFeature } from "../shared/requireFeature";
import { sanitizeEmailField, sanitizeHeaderValue } from "../emails/sanitize";
import { isValidEmail } from "../shared/email";
import {
  QuoteSent,
  buildQuoteSentPreviewText,
} from "../emails/templates/QuoteSent";
import type { TenantSnapshotForEmail } from "../emails/components/TenantEmailLayout";

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

const FROM_DOMAIN = "techflowsolutions.ca";
const FROM_EMAIL = `notifications@${FROM_DOMAIN}`;

export async function sendQuoteEmailHandler(
  request: CallableRequest,
): Promise<{ success: true }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  await requireFeature(tenantId, "quotes");

  const { quoteId } = (request.data ?? {}) as { quoteId?: string };
  if (!quoteId || typeof quoteId !== "string") {
    throw new HttpsError("invalid-argument", "quoteId required.");
  }

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

  // Build email props.
  const snapshot = quote.tenantSnapshot ?? {};
  const tenant: TenantSnapshotForEmail = {
    name: snapshot.name ?? "",
    address: snapshot.address ?? null,
    logoUrl: snapshot.logo ?? null,
    emailFooter: snapshot.emailFooter ?? null,
    primaryColor: snapshot.primaryColor ?? null,
  };

  const appUrl =
    process.env.APP_URL || "https://portal.techflowsolutions.ca";

  const viewUrl = `${appUrl}/portal/quotes/${quoteSnap.id}?tenantId=${tenantId}`;

  const currency = snapshot.currency ?? "CAD";
  const totalFormatted = formatCurrency(quote.totals?.total ?? 0, currency);
  const customerFirstName =
    quote.customer.name?.split(" ")[0] ?? "there";

  const props = {
    tenant,
    customerFirstName,
    quoteNumber: quoteSnap.id,
    totalFormatted,
    validUntilFormatted: quote.validUntil ?? "",
    viewUrl,
  };

  // Render email.
  const html = await render(createElement(QuoteSent, props));
  const text = await render(createElement(QuoteSent, props), {
    plainText: true,
  });

  // Send via Resend.
  const safeTenantName =
    sanitizeEmailField(snapshot.name, 100) || "TechFlow";
  const subject = `Quote ${quoteSnap.id} from ${safeTenantName} — ${totalFormatted}`;

  let replyTo: string | undefined;
  const metaSnap = await db
    .doc(`tenants/${tenantId}/meta/settings`)
    .get();
  if (metaSnap.exists) {
    const metaEmail = metaSnap.data()?.emailFrom ?? metaSnap.data()?.etransferEmail;
    if (metaEmail) {
      const cleaned = sanitizeHeaderValue(metaEmail, 200);
      if (cleaned && isValidEmail(cleaned)) {
        replyTo = cleaned;
      }
    }
  }

  const resend = new Resend(RESEND_API_KEY.value());
  const idempotencyKey = `sendQuoteEmail:${tenantId}:${quoteId}`;

  const payload: Parameters<typeof resend.emails.send>[0] = {
    from: `${safeTenantName} <${FROM_EMAIL}>`,
    to: quote.customer.email,
    subject,
    html,
    text,
  };
  if (replyTo) payload.replyTo = replyTo;

  const headers: Record<string, string> = {
    "Idempotency-Key": idempotencyKey,
  };

  await resend.emails.send(payload, { headers } as never);

  logger.info("sendQuoteEmail", {
    to: quote.customer.email,
    quoteId,
    tenantId,
    preview: buildQuoteSentPreviewText(props),
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

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

export const sendQuoteEmail = onCall(
  { secrets: [RESEND_API_KEY] },
  sendQuoteEmailHandler,
);
