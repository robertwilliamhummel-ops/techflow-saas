// sendInvoiceEmail — Phase 2 Bundle F.
//
// Tenant callable: reads invoice doc, renders InvoiceSent template, sends
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
  InvoiceSent,
  buildInvoiceSentPreviewText,
} from "../emails/templates/InvoiceSent";
import type { TenantSnapshotForEmail } from "../emails/components/TenantEmailLayout";

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

const FROM_DOMAIN = "techflowsolutions.ca";
const FROM_EMAIL = `notifications@${FROM_DOMAIN}`;

export async function sendInvoiceEmailHandler(
  request: CallableRequest,
): Promise<{ success: true }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  await requireFeature(tenantId, "invoices");

  const { invoiceId } = (request.data ?? {}) as { invoiceId?: string };
  if (!invoiceId || typeof invoiceId !== "string") {
    throw new HttpsError("invalid-argument", "invoiceId required.");
  }

  // Load invoice.
  const invoiceRef = db.doc(`tenants/${tenantId}/invoices/${invoiceId}`);
  const invoiceSnap = await invoiceRef.get();
  if (!invoiceSnap.exists) {
    throw new HttpsError("not-found", "Invoice not found.");
  }
  const invoice = invoiceSnap.data()!;

  if (!invoice.customer?.email) {
    throw new HttpsError(
      "failed-precondition",
      "Invoice has no customer email.",
    );
  }

  // Build email props.
  const snapshot = invoice.tenantSnapshot ?? {};
  const tenant: TenantSnapshotForEmail = {
    name: snapshot.name ?? "",
    address: snapshot.address ?? null,
    logoUrl: snapshot.logo ?? null,
    emailFooter: snapshot.emailFooter ?? null,
    primaryColor: snapshot.primaryColor ?? null,
  };

  // Determine the base URL for pay links.
  const appUrl =
    process.env.APP_URL || "https://portal.techflowsolutions.ca";

  const payUrl = invoice.payToken
    ? `${appUrl}/pay/${invoice.payToken}`
    : `${appUrl}/portal/login`;

  const portalLoginUrl = `${appUrl}/portal/login`;

  // Format values for the template.
  const currency = snapshot.currency ?? "CAD";
  const totalFormatted = formatCurrency(invoice.totals?.total ?? 0, currency);
  const customerFirstName =
    invoice.customer.name?.split(" ")[0] ?? "there";

  const props = {
    tenant,
    customerFirstName,
    invoiceNumber: invoiceSnap.id,
    totalFormatted,
    dueDateFormatted: invoice.dueDate ?? "",
    payUrl,
    portalLoginUrl,
  };

  // Render email.
  const html = await render(createElement(InvoiceSent, props));
  const text = await render(createElement(InvoiceSent, props), {
    plainText: true,
  });

  // Send via Resend.
  const safeTenantName =
    sanitizeEmailField(snapshot.name, 100) || "TechFlow";
  const subject = `Invoice ${invoiceSnap.id} from ${safeTenantName} — ${totalFormatted}`;

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
  const idempotencyKey = `sendInvoiceEmail:${tenantId}:${invoiceId}`;

  const payload: Parameters<typeof resend.emails.send>[0] = {
    from: `${safeTenantName} <${FROM_EMAIL}>`,
    to: invoice.customer.email,
    subject,
    html,
    text,
  };
  if (replyTo) payload.replyTo = replyTo;

  const headers: Record<string, string> = {
    "Idempotency-Key": idempotencyKey,
  };

  await resend.emails.send(payload, { headers } as never);

  logger.info("sendInvoiceEmail", {
    to: invoice.customer.email,
    invoiceId,
    tenantId,
    preview: buildInvoiceSentPreviewText(props),
  });

  // Transition draft → sent.
  if (invoice.status === "draft") {
    await invoiceRef.update({
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

export const sendInvoiceEmail = onCall(
  { secrets: [RESEND_API_KEY] },
  sendInvoiceEmailHandler,
);
