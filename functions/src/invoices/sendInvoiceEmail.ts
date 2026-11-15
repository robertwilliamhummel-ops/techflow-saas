// sendInvoiceEmail — Phase 2 Bundle F; transport moved to Amazon SES (D5).
//
// Tenant callable: reads invoice doc, renders InvoiceSent template, sends via
// emails/send.ts with the invoice PDF attached (D14). Transitions status from
// "draft" to "sent" if currently draft. Not deduplicated — pressing Send again
// is a legitimate resend.
//
// The email's Pay button and the PDF's pay link carry the stored pay token,
// which lives 60 days from creation. A token that is missing, expired, nearly
// expired, or dies before the due date is re-issued first, the way
// regenerateInvoicePayLink does (payLinkNeedsReissue in shared/payToken.ts), so
// a resend of an overdue invoice never mails a dead link.

import {
  onCall,
  HttpsError,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { createElement } from "react";
import { render } from "@react-email/render";
import { defineSecret } from "firebase-functions/params";
import { db, FieldValue, Timestamp } from "../shared/admin";
import { readClaims, requireTenant } from "../shared/auth";
import { requireDocId } from "../shared/docId";
import { isPayableInvoiceStatus } from "../shared/invoiceStatus";
import { payPageUrl, portalDocumentUrl } from "../shared/portalLinks";
import {
  PDF_SERVICE_API_KEY,
  pdfAttachmentFilename,
  renderInvoicePdf,
  renderPdfOrThrow,
} from "../shared/documentPdf";
import { requireFeature } from "../shared/requireFeature";
import {
  PAY_LINK_TTL_MS,
  payLinkNeedsReissue,
  payTokenExpiryMs,
  signPayToken,
} from "../shared/payToken";
import { RATE_LIMITS, enforceRateLimit } from "../shared/rateLimit";
import { withSentryCallable } from "../shared/withSentry";
import { sanitizeEmailField } from "../emails/sanitize";
import { EMAIL_SECRETS, pickReplyTo, sendEmail } from "../emails/send";
import { formatCurrency } from "../emails/format";
import { emailLogoUrl } from "../shared/logo";
import { InvoiceSent } from "../emails/templates/InvoiceSent";
import type { TenantSnapshotForEmail } from "../emails/components/TenantEmailLayout";

const PAY_TOKEN_SECRET = defineSecret("PAY_TOKEN_SECRET");

type InvoiceData = FirebaseFirestore.DocumentData;

function assertSendable(invoice: InvoiceData): void {
  // A-12: a void invoice is cancelled; sending it would ask for payment.
  if (invoice.status === "void") {
    throw new HttpsError(
      "failed-precondition",
      "This invoice is void and can't be sent.",
    );
  }

  // S-04: the email asks the customer to pay, so only a draft or an invoice
  // that still has something to pay can go out (the same statuses
  // regenerateInvoicePayLink issues links for). Receipts for paid invoices come
  // from onInvoicePaid.
  if (invoice.status !== "draft" && !isPayableInvoiceStatus(invoice.status)) {
    const status = String(invoice.status ?? "unknown").replace("-", " ");
    throw new HttpsError(
      "failed-precondition",
      `This invoice is ${status}, so there's nothing left to pay and it can't be sent.`,
    );
  }
}

// Re-issues the pay link in a transaction (version + 1, new token and expiry),
// re-checking the invoice so two sends at once issue one link and a send that
// races a void or payment doesn't issue one at all. Returns the invoice as the
// email and PDF should see it.
async function withSendablePayLink(
  invoiceRef: FirebaseFirestore.DocumentReference,
  tenantId: string,
  invoiceId: string,
): Promise<{ invoice: InvoiceData; payLinkRegenerated: boolean }> {
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(invoiceRef);
    if (!snap.exists) {
      throw new HttpsError("not-found", "Invoice not found.");
    }
    const invoice = snap.data()!;
    assertSendable(invoice);
    const now = Date.now();
    if (!payLinkNeedsReissue(invoice.payToken, invoice.dueDate, now)) {
      return { invoice, payLinkRegenerated: false };
    }

    const payTokenVersion = Number(invoice.payTokenVersion ?? 0) + 1;
    const payToken = signPayToken(
      { invoiceId, tenantId, v: payTokenVersion },
      PAY_TOKEN_SECRET.value(),
    );
    const payTokenExpiresAt = Timestamp.fromMillis(
      payTokenExpiryMs(payToken) ?? now + PAY_LINK_TTL_MS,
    );
    tx.update(invoiceRef, { payToken, payTokenVersion, payTokenExpiresAt });
    return {
      invoice: { ...invoice, payToken, payTokenVersion, payTokenExpiresAt },
      payLinkRegenerated: true,
    };
  });
}

export async function sendInvoiceEmailHandler(
  request: CallableRequest,
): Promise<{ success: true; payLinkRegenerated: boolean }> {
  const claims = readClaims(request);
  const { uid, tenantId } = requireTenant(claims);
  const features = await requireFeature(tenantId, "invoices");
  await enforceRateLimit(uid, RATE_LIMITS.sendEmail);

  const data = request.data as Record<string, unknown> | undefined;
  const invoiceId = requireDocId(data?.invoiceId, "invoiceId");

  // Load invoice.
  const invoiceRef = db.doc(`tenants/${tenantId}/invoices/${invoiceId}`);
  const invoiceSnap = await invoiceRef.get();
  if (!invoiceSnap.exists) {
    throw new HttpsError("not-found", "Invoice not found.");
  }
  let invoice = invoiceSnap.data()!;

  if (!invoice.customer?.email) {
    throw new HttpsError(
      "failed-precondition",
      "Invoice has no customer email.",
    );
  }

  assertSendable(invoice);

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

  // A fresh-enough link is reused, so links in earlier emails keep working.
  let payLinkRegenerated = false;
  if (payLinkNeedsReissue(invoice.payToken, invoice.dueDate, Date.now())) {
    ({ invoice, payLinkRegenerated } = await withSendablePayLink(
      invoiceRef,
      tenantId,
      invoiceId,
    ));
  }

  // Build email props.
  const snapshot = invoice.tenantSnapshot ?? {};
  const tenant: TenantSnapshotForEmail = {
    name: snapshot.name ?? "",
    address: snapshot.address ?? null,
    // A-06: hosted copy, never inline image data (Gmail clips emails over 102 KB).
    logoUrl: emailLogoUrl(snapshot),
    emailFooter: snapshot.emailFooter ?? null,
    primaryColor: snapshot.primaryColor ?? null,
  };

  // S-10: both links use the business's own domain once it is verified. The
  // portal link opens this invoice, and signing in returns the customer to it.
  const portalUrl = portalDocumentUrl(meta, "invoice", tenantId, invoiceSnap.id);
  const payUrl = invoice.payToken ? payPageUrl(meta, invoice.payToken) : portalUrl;

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
    portalUrl,
  };

  const html = await render(createElement(InvoiceSent, props));
  const text = await render(createElement(InvoiceSent, props), {
    plainText: true,
  });

  const safeTenantName =
    sanitizeEmailField(snapshot.name, 100) || "TechFlow";

  // D14: the customer gets the invoice itself, not only a link to it — for
  // their records and taxes, and when they pay another way (cash, cheque).
  const pdf = await renderPdfOrThrow(
    () =>
      renderInvoicePdf({
        tenantId,
        invoiceId,
        invoice,
        features,
        meta,
      }),
    "invoice",
  );

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
    attachments: [
      {
        filename: pdfAttachmentFilename(snapshot.name, invoiceId),
        contentType: "application/pdf",
        content: pdf,
      },
    ],
  });

  // Transition draft → sent.
  if (invoice.status === "draft") {
    await invoiceRef.update({
      status: "sent",
      sentAt: FieldValue.serverTimestamp(),
    });
  }

  return { success: true, payLinkRegenerated };
}

export const sendInvoiceEmail = onCall(
  { secrets: [...EMAIL_SECRETS, PDF_SERVICE_API_KEY, PAY_TOKEN_SECRET] },
  withSentryCallable("sendInvoiceEmail", sendInvoiceEmailHandler),
);
