// Owner-facing payment incident emails (decision D5). Platform-branded
// ("TechFlow"), sent to every active tenant owner by onPaymentIncidentCreated.
// Pure builders — no I/O. Stripe-sourced strings are HTML-escaped.

import { formatCurrency } from "./format";

export const NOTIFIABLE_INCIDENT_KINDS = [
  "auto-refund-version-mismatch",
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
    case "auto-refund-version-mismatch": {
      const refundId =
        typeof incident.refundId === "string" ? incident.refundId : null;
      const { text, html } = paragraphs([
        `Heads up — a customer paid invoice ${invoiceId} after you regenerated its pay link.`,
        "Because the link they used was no longer current, the payment was automatically refunded so they aren't charged on a stale link.",
        refundId
          ? `Stripe refund ID: ${refundId}.`
          : "The refund could not be issued automatically — refund it manually in your Stripe Dashboard.",
        "If you meant to accept this payment, send the customer a fresh invoice with the new pay link.",
      ]);
      return {
        subject: `Payment auto-refunded on ${invoiceId} (pay link was regenerated)`,
        text,
        html,
      };
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
