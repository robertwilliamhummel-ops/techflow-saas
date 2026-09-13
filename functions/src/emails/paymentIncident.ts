// Owner-facing payment incident emails (decision D5). Platform-branded
// ("TechFlow"), sent to every active tenant owner by onPaymentIncidentCreated.
// Pure builders — no I/O. Stripe-sourced strings are HTML-escaped.

import { formatCurrency } from "./format";

export const NOTIFIABLE_INCIDENT_KINDS = [
  "auto-refund-version-mismatch",
  "auto-refund-amount-mismatch",
  "auto-refund-duplicate-payment",
  "auto-refund-not-payable",
  "dispute-created",
  "dispute-lost",
] as const;

export type NotifiableIncidentKind = (typeof NOTIFIABLE_INCIDENT_KINDS)[number];

export function isNotifiableIncidentKind(
  kind: unknown,
): kind is NotifiableIncidentKind {
  return (
    typeof kind === "string" &&
    (NOTIFIABLE_INCIDENT_KINDS as readonly string[]).includes(kind)
  );
}

export interface IncidentEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );
}

function paragraphs(lines: string[]): { text: string; html: string } {
  const body = lines.filter((l) => l.length > 0);
  return {
    text: `${body.join("\n\n")}\n\n— TechFlow`,
    html:
      body.map((l) => `<p>${escapeHtml(l)}</p>`).join("") +
      `<p style="color:#666;font-size:12px">— TechFlow</p>`,
  };
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  card: "by card",
  etransfer: "by e-Transfer",
  cash: "in cash",
  manual: "manually",
};

function money(cents: unknown, currency: unknown): string | null {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return null;
  return formatCurrency(
    cents / 100,
    typeof currency === "string" && currency ? currency : "CAD",
  );
}

// Every auto-refund email has the same shape: what happened, whether the refund
// went through (the subject changes when it didn't), and what to do next.
function autoRefundEmail(
  invoiceId: string,
  incident: Record<string, unknown>,
  label: string,
  whatHappened: string,
  nextStep: string,
): IncidentEmail {
  const refundId =
    typeof incident.refundId === "string" ? incident.refundId : null;
  const outcome = refundId
    ? `The payment was automatically refunded to the customer (Stripe refund ID: ${refundId}).`
    : "The automatic refund failed, so the customer is still charged — refund this payment manually in your Stripe Dashboard.";
  const { text, html } = paragraphs([whatHappened, outcome, nextStep]);
  return {
    subject: `${refundId ? "Payment auto-refunded" : "Refund needed"} on ${invoiceId} (${label})`,
    text,
    html,
  };
}

export function buildPaymentIncidentEmail(
  kind: NotifiableIncidentKind,
  ctx: {
    tenantName: string;
    invoiceId: string;
    incident: Record<string, unknown>;
  },
): IncidentEmail {
  const { tenantName, invoiceId, incident } = ctx;

  switch (kind) {
    case "auto-refund-version-mismatch":
      return autoRefundEmail(
        invoiceId,
        incident,
        "pay link was regenerated",
        `A customer paid invoice ${invoiceId} using a pay link you had since regenerated, so the payment couldn't be kept.`,
        "If you meant to accept this payment, send the customer a fresh invoice with the new pay link.",
      );
    case "auto-refund-amount-mismatch": {
      const charged = money(incident.chargedCents, incident.currency);
      const expected = money(
        incident.expectedCents,
        typeof incident.invoiceCurrency === "string"
          ? incident.invoiceCurrency
          : incident.currency,
      );
      return autoRefundEmail(
        invoiceId,
        incident,
        "amount didn't match",
        `A card payment on invoice ${invoiceId} didn't match the invoice amount${
          charged && expected
            ? ` (charged ${charged}, invoice total ${expected})`
            : ""
        }, so it couldn't be kept.`,
        "This usually means the invoice changed after the customer opened the payment page. Send them the current invoice so they can pay the right amount.",
      );
    }
    case "auto-refund-duplicate-payment": {
      const method =
        typeof incident.existingPaymentMethod === "string"
          ? PAYMENT_METHOD_LABELS[incident.existingPaymentMethod]
          : undefined;
      return autoRefundEmail(
        invoiceId,
        incident,
        "invoice was already paid",
        `Invoice ${invoiceId} was already paid${method ? ` (${method})` : ""}, so a second card payment from the customer couldn't be kept.`,
        "No action is needed unless the customer meant to pay a different invoice.",
      );
    }
    case "auto-refund-not-payable": {
      const status =
        typeof incident.invoiceStatus === "string"
          ? incident.invoiceStatus
          : null;
      return autoRefundEmail(
        invoiceId,
        incident,
        "invoice not open for payment",
        status
          ? `A card payment arrived for invoice ${invoiceId}, which isn't open for payment (status: ${status}), so it couldn't be kept.`
          : `A card payment arrived for invoice ${invoiceId}, which no longer exists, so it couldn't be kept.`,
        "If the customer still owes you, send them a current invoice.",
      );
    }
    case "dispute-created": {
      const reason =
        typeof incident.disputeReason === "string"
          ? incident.disputeReason
          : "unspecified";
      const dueBy =
        typeof incident.evidenceDueBy === "string"
          ? incident.evidenceDueBy
          : null;
      const { text, html } = paragraphs([
        `A customer disputed the payment on invoice ${invoiceId}.`,
        `Reason reported by their card issuer: ${reason}.`,
        dueBy
          ? `Stripe needs your evidence by ${dueBy}. Missing the deadline means an automatic loss.`
          : "Check your Stripe Dashboard for the evidence deadline. Missing it means an automatic loss.",
        "Sign in to your Stripe Dashboard → Disputes and upload your evidence (invoice PDF, messages with the customer, proof of service).",
      ]);
      return {
        subject: `Chargeback opened on ${invoiceId} for ${tenantName}`,
        text,
        html,
      };
    }
    case "dispute-lost": {
      const amountCents =
        typeof incident.amountCents === "number" ? incident.amountCents : null;
      const { text, html } = paragraphs([
        `The chargeback on invoice ${invoiceId} closed against you, and the payment has been returned to the customer.`,
        amountCents != null
          ? `Amount returned: ${formatCurrency(amountCents / 100, "CAD")}.`
          : "",
        "The invoice is now marked refunded in your dashboard. If you believe the decision was wrong, contact Stripe support — TechFlow cannot reverse a closed dispute.",
      ]);
      return {
        subject: `Chargeback lost on ${invoiceId} — payment returned`,
        text,
        html,
      };
    }
  }
}
