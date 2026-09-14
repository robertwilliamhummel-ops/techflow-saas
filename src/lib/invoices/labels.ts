// Words for stored invoice codes, shown on the invoice detail page (S-04).

import type { EmailDeliveryStatus, PaymentMethod } from "@/lib/schema/tenant";

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  manual: "Recorded manually",
  etransfer: "e-Transfer",
  cash: "Cash",
  card: "Card",
};

/** Methods an owner can record by hand (markInvoicePaid); card comes from Stripe. */
export const MANUAL_PAYMENT_METHODS = ["etransfer", "cash", "manual"] as const satisfies readonly PaymentMethod[];

export type EmailStatusTone = "success" | "warning" | "destructive";

export const EMAIL_STATUS: Record<EmailDeliveryStatus, { label: string; tone: EmailStatusTone }> = {
  delivered: { label: "Delivered", tone: "success" },
  delayed: { label: "Delayed", tone: "warning" },
  bounced: { label: "Bounced", tone: "destructive" },
  complained: { label: "Marked as spam", tone: "destructive" },
  rejected: { label: "Rejected", tone: "destructive" },
};

export function paymentMethodLabel(method: string | null | undefined): string | null {
  return method && method in PAYMENT_METHOD_LABELS
    ? PAYMENT_METHOD_LABELS[method as PaymentMethod]
    : null;
}
