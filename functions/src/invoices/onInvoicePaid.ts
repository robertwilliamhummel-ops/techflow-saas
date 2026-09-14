// onInvoicePaid — E-01.
//
// Firestore trigger: emails the customer a PaymentReceipt when an invoice
// becomes paid. Card payments (recorded by the Stripe webhook in Next.js)
// always get one; payments the business records itself (markInvoicePaid) only
// when the owner asked for a receipt (`receiptRequested`). Email stays in Cloud
// Functions behind one SES credential (D5). Firestore triggers can be delivered
// more than once, so the send is keyed on the invoice and its paidAt.
//
// For direct charges Stripe applies the connected account's own Customer emails
// settings, so a contractor who turns on "Successful payments" in their Stripe
// Dashboard also sends Stripe's receipt. The runbook recommends leaving it off.

import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import { createElement } from "react";
import { render } from "@react-email/render";
import { db } from "../shared/admin";
import { isValidEmail } from "../shared/email";
import { emailLogoUrl } from "../shared/logo";
import { EMAIL_SECRETS, pickReplyTo, sendEmail } from "../emails/send";
import { formatCurrency } from "../emails/format";
import { sanitizeEmailField } from "../emails/sanitize";
import { PaymentReceipt } from "../emails/templates/PaymentReceipt";
import { withSentryEvent } from "../shared/withSentry";

const METHOD_LABELS: Record<string, string> = {
  card: "Credit card",
  etransfer: "Interac e-Transfer",
  cash: "Cash",
  manual: "Other",
};

// Tenants are Canadian businesses based in the GTA; invoice dates elsewhere
// are plain YYYY-MM-DD strings, so this only formats the receipt's paid date.
const PAID_ON_FORMAT = new Intl.DateTimeFormat("en-CA", {
  dateStyle: "long",
  timeZone: "America/Toronto",
});

type InvoiceData = Record<string, unknown>;

export async function handleInvoicePaid(params: {
  tenantId: string;
  invoiceId: string;
  before: InvoiceData | undefined;
  after: InvoiceData | undefined;
}): Promise<{ sent: boolean; reason?: string }> {
  const { tenantId, invoiceId, before, after } = params;

  if (!after || after.status !== "paid" || before?.status === "paid") {
    return { sent: false, reason: "not-a-new-payment" };
  }

  const method = String(after.paymentMethod ?? "manual");
  if (method !== "card" && after.receiptRequested !== true) {
    return { sent: false, reason: "not-requested" };
  }

  const customer = (after.customer ?? {}) as { name?: unknown; email?: unknown };
  if (!isValidEmail(customer.email)) {
    logger.warn("invoicePaid: no valid customer email, receipt skipped", {
      tenantId,
      invoiceId,
    });
    return { sent: false, reason: "no-customer-email" };
  }

  const snapshot = (after.tenantSnapshot ?? {}) as Record<string, unknown>;
  const currency = String(snapshot.currency ?? "CAD");
  const total = Number((after.totals as { total?: unknown } | undefined)?.total ?? 0);
  const paidCents =
    typeof after.paidAmountCents === "number" ? after.paidAmountCents : null;
  const feeCents =
    typeof after.surchargeAmountCents === "number" ? after.surchargeAmountCents : 0;

  // Card: what Stripe actually charged (invoice amount + any surcharge, D3).
  const amountPaid =
    method === "card" && paidCents !== null ? (paidCents + feeCents) / 100 : total;
  const cardFee = method === "card" && feeCents > 0 ? feeCents / 100 : null;

  const paidAt = after.paidAt as { toMillis?: () => number } | undefined;
  const paidAtMs = typeof paidAt?.toMillis === "function" ? paidAt.toMillis() : null;

  const metaSnap = await db.doc(`tenants/${tenantId}/meta/settings`).get();
  const meta: FirebaseFirestore.DocumentData = metaSnap.data() ?? {};

  const appUrl = process.env.APP_URL || "https://portal.techflowsolutions.ca";
  const props = {
    tenant: {
      name: String(snapshot.name ?? ""),
      address: (snapshot.address as string | null | undefined) ?? null,
      // A-06: hosted copy, never the base64 logo.
      logoUrl: emailLogoUrl(snapshot as Parameters<typeof emailLogoUrl>[0]),
      emailFooter: (snapshot.emailFooter as string | null | undefined) ?? null,
      primaryColor: (snapshot.primaryColor as string | null | undefined) ?? null,
    },
    customerFirstName: String(customer.name ?? "").split(" ")[0] || "there",
    invoiceNumber: invoiceId,
    amountPaidFormatted: formatCurrency(amountPaid, currency),
    paidOnFormatted: PAID_ON_FORMAT.format(paidAtMs === null ? new Date() : new Date(paidAtMs)),
    paymentMethodLabel: METHOD_LABELS[method] ?? METHOD_LABELS.manual,
    cardFeeFormatted: cardFee === null ? null : formatCurrency(cardFee, currency),
    portalUrl: `${appUrl}/portal/login`,
  };

  const html = await render(createElement(PaymentReceipt, props));
  const text = await render(createElement(PaymentReceipt, props), {
    plainText: true,
  });
  const safeTenantName = sanitizeEmailField(props.tenant.name, 100) || "TechFlow";

  try {
    const result = await sendEmail({
      to: String(customer.email),
      subject: `Receipt for invoice ${invoiceId} from ${safeTenantName}`,
      html,
      text,
      fromName: safeTenantName,
      replyTo: pickReplyTo(meta.contactEmail, meta.etransferEmail),
      category: "payment-receipt",
      tenantId,
      documentId: invoiceId,
      idempotencyKey: `receipt:${tenantId}:${invoiceId}:${paidAtMs ?? "unknown"}`,
    });
    return result.deduplicated
      ? { sent: false, reason: "already-sent" }
      : { sent: true };
  } catch (err) {
    // The payment itself is recorded; a missing receipt is logged, not retried
    // into a loop.
    logger.error("invoicePaid: receipt email failed", {
      tenantId,
      invoiceId,
      error: String(err),
    });
    return { sent: false, reason: "send-failed" };
  }
}

export const onInvoicePaid = onDocumentUpdated(
  {
    document: "tenants/{tenantId}/invoices/{invoiceId}",
    secrets: EMAIL_SECRETS,
  },
  withSentryEvent("onInvoicePaid", async (event) => {
    await handleInvoicePaid({
      tenantId: event.params.tenantId,
      invoiceId: event.params.invoiceId,
      before: event.data?.before.data(),
      after: event.data?.after.data(),
    });
  }),
);
