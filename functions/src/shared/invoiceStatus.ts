// Invoice status groups shared by the callables (A-12).
//
// Payable: a customer may pay by card and an owner may record a manual
// payment. Voidable: issued, with no money recorded. Drafts are deleted rather
// than voided, and anything with a payment must be refunded first. The Stripe
// webhook keeps its own copy of the payable list (src/app/api/webhooks/stripe).

export const PAYABLE_INVOICE_STATUSES = [
  "sent",
  "unpaid",
  "overdue",
  "partial",
] as const;

export const VOIDABLE_INVOICE_STATUSES = ["sent", "unpaid", "overdue"] as const;

export function isPayableInvoiceStatus(status: unknown): boolean {
  return (
    typeof status === "string" &&
    (PAYABLE_INVOICE_STATUSES as readonly string[]).includes(status)
  );
}

export function isVoidableInvoiceStatus(status: unknown): boolean {
  return (
    typeof status === "string" &&
    (VOIDABLE_INVOICE_STATUSES as readonly string[]).includes(status)
  );
}
