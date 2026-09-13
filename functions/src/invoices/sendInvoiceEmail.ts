// sendInvoiceEmail — Phase 2 Bundle F; transport moved to Amazon SES (D5).
//
// Tenant callable: reads invoice doc, renders InvoiceSent template, sends via
// emails/send.ts. Transitions status from "draft" to "sent" if currently draft.
// Not deduplicated — pressing Send again is a legitimate resend.

import {
  onCall,
  HttpsError,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { createElement } from "react";
import { render } from "@react-email/render";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requireTenant } from "../shared/auth";
import { requireFeature } from "../shared/requireFeature";
import { sanitizeEmailField } from "../emails/sanitize";
import { EMAIL_SECRETS, pickReplyTo, sendEmail } from "../emails/send";
import { formatCurrency } from "../emails/format";
import { emailLogoUrl } from "../shared/logo";
import { InvoiceSent } from "../emails/templates/InvoiceSent";
import type { TenantSnapshotForEmail } from "../emails/components/TenantEmailLayout";

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

  // A-12: a void invoice is cancelled; sending it would ask for payment.
  if (invoice.status === "void") {
    throw new HttpsError(
      "failed-precondition",
      "This invoice is void and can't be sent.",
    );
  }

  // Phase 4 Bundle E — refuse to send if the customer would have no way to
  // pay. Card payments require stripeStatus.chargesEnabled === true; e-transfer
  // requires meta.etransferEmail. If neither is available, sending the invoice
  // is just noise — tell the tenant to finish setup instead.
  const metaSnap = await db.doc(`tenants/${tenantId}/meta/settings`).get();
  const meta = metaSnap.exists ? metaSnap.data()! : {};
  if (metaSnap.exists) {
    const cardReady =
      (meta.stripeStatus as { chargesEnabled?: boolean } | undefined)
        ?.chargesEnabled === true;
    const etransferReady =
      typeof meta.etransferEmail === "string" && meta.etransferEmail.length > 0;
    if (!cardReady && !etransferReady) {
      throw new HttpsError(
        "failed-precondition",
        "Add an e-transfer email or finish Stripe onboarding before sending invoices.",
      );
    }
  }

  // Build email props.
  const snapshot = invoice.tenantSnapshot ?? {};
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
  const payUrl = invoice.payToken
    ? `${appUrl}/pay/${invoice.payToken}`
    : `${appUrl}/portal/login`;

  const totalFormatted = formatCurrency(
    invoice.totals?.total ?? 0,
    snapshot.currency ?? "CAD",
  );

  const props = {
    tenant,
    customerFirstName: invoice.customer.name?.split(" ")[0] ?? "there",
    invoiceNumber: invoiceSnap.id,
    totalFormatted,
    dueDateFormatted: invoice.dueDate ?? "",
    payUrl,
    portalLoginUrl: `${appUrl}/portal/login`,
  };

  const html = await render(createElement(InvoiceSent, props));
  const text = await render(createElement(InvoiceSent, props), {
    plainText: true,
  });

  const safeTenantName =
    sanitizeEmailField(snapshot.name, 100) || "TechFlow";

  await sendEmail({
    to: invoice.customer.email,
    subject: `Invoice ${invoiceSnap.id} from ${safeTenantName} — ${totalFormatted}`,
    html,
    text,
    fromName: safeTenantName,
    replyTo: pickReplyTo(meta.contactEmail, meta.etransferEmail),
    category: "invoice",
    tenantId,
    documentId: invoiceId,
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

export const sendInvoiceEmail = onCall(
  { secrets: EMAIL_SECRETS },
  sendInvoiceEmailHandler,
);
