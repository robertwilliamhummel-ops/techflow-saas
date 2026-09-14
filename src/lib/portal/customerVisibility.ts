// Which document statuses a customer may see (A-05). Drafts are the business's
// work in progress and never reach a customer — not in the portal lists, not
// on the portal pages, not as a PDF.
//
// Mirrors functions/src/shared/customerVisibility.ts (and firestore.rules);
// src/lib/__tests__/customerVisibility.test.ts pins the copies together.

import type { InvoiceStatus, QuoteStatus } from "@/lib/schema/tenant";

export const CUSTOMER_VISIBLE_INVOICE_STATUSES = [
  "sent",
  "unpaid",
  "overdue",
  "partial",
  "paid",
  "refunded",
  "partially-refunded",
  "void",
] as const satisfies readonly InvoiceStatus[];

export const CUSTOMER_VISIBLE_QUOTE_STATUSES = [
  "sent",
  "accepted",
  "declined",
  "expired",
  "converted",
] as const satisfies readonly QuoteStatus[];

export function isCustomerVisibleInvoiceStatus(status: unknown): status is InvoiceStatus {
  return (
    typeof status === "string" &&
    (CUSTOMER_VISIBLE_INVOICE_STATUSES as readonly string[]).includes(status)
  );
}

export function isCustomerVisibleQuoteStatus(status: unknown): status is QuoteStatus {
  return (
    typeof status === "string" &&
    (CUSTOMER_VISIBLE_QUOTE_STATUSES as readonly string[]).includes(status)
  );
}
