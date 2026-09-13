// Which document statuses a customer may see through the portal (A-05).
//
// Drafts are the business's work in progress and are never shown. Allow-lists
// rather than "not draft" so any status added later stays hidden until it is
// deliberately listed here.
//
// firestore.rules repeats these lists for direct customer reads — change both
// together. The rules tests iterate these constants, so a mismatch fails there.

export const CUSTOMER_VISIBLE_INVOICE_STATUSES = [
  "sent",
  "unpaid",
  "overdue",
  "partial",
  "paid",
  "refunded",
  "partially-refunded",
] as const;

export const CUSTOMER_VISIBLE_QUOTE_STATUSES = [
  "sent",
  "accepted",
  "declined",
  "expired",
  "converted",
] as const;

export function isCustomerVisibleInvoiceStatus(status: unknown): boolean {
  return (
    typeof status === "string" &&
    (CUSTOMER_VISIBLE_INVOICE_STATUSES as readonly string[]).includes(status)
  );
}

export function isCustomerVisibleQuoteStatus(status: unknown): boolean {
  return (
    typeof status === "string" &&
    (CUSTOMER_VISIBLE_QUOTE_STATUSES as readonly string[]).includes(status)
  );
}
