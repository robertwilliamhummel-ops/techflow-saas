// Invoices list filters and search (S-02). Each filter is one Firestore query
// (`status in [...]`, newest first); Overdue then narrows the payable invoices
// by due date on the client, since nothing stores `overdue` (dueStatus.ts).
// Firestore has no text search, so search matches the invoices already loaded.

import { PAYABLE_INVOICE_STATUSES, isPastDue } from "./dueStatus";
import { matchesSearch } from "@/lib/search";
import type { Invoice, InvoiceStatus } from "@/lib/schema/tenant";

export type InvoiceFilterKey =
  | "all"
  | "outstanding"
  | "overdue"
  | "draft"
  | "paid"
  | "refunded"
  | "void";

export interface InvoiceListFilter {
  key: InvoiceFilterKey;
  label: string;
  /** Statuses to query; null queries every invoice. */
  statuses: readonly InvoiceStatus[] | null;
  /** Keep only invoices past their due date. */
  pastDueOnly: boolean;
}

export const INVOICE_LIST_FILTERS: readonly InvoiceListFilter[] = [
  { key: "all", label: "All", statuses: null, pastDueOnly: false },
  { key: "outstanding", label: "Outstanding", statuses: PAYABLE_INVOICE_STATUSES, pastDueOnly: false },
  { key: "overdue", label: "Overdue", statuses: PAYABLE_INVOICE_STATUSES, pastDueOnly: true },
  { key: "draft", label: "Drafts", statuses: ["draft"], pastDueOnly: false },
  { key: "paid", label: "Paid", statuses: ["paid"], pastDueOnly: false },
  { key: "refunded", label: "Refunded", statuses: ["refunded", "partially-refunded"], pastDueOnly: false },
  { key: "void", label: "Void", statuses: ["void"], pastDueOnly: false },
];

/** The filter named in the URL, or All for anything unrecognized. */
export function invoiceFilterFor(raw: string | null | undefined): InvoiceListFilter {
  return INVOICE_LIST_FILTERS.find((filter) => filter.key === raw) ?? INVOICE_LIST_FILTERS[0];
}

/** The list URL for a filter; All is the bare path. */
export function invoiceFilterHref(key: InvoiceFilterKey): string {
  return key === "all" ? "/invoices" : `/invoices?status=${key}`;
}

export type SearchableInvoice = Pick<Invoice, "customer"> & { id: string };

/** Matches customer name, customer email, or invoice number. */
export function matchesInvoiceSearch(invoice: SearchableInvoice, query: string): boolean {
  return matchesSearch([invoice.id, invoice.customer.name, invoice.customer.email], query);
}

export function visibleInvoices<
  T extends SearchableInvoice & Pick<Invoice, "status" | "dueDate">,
>(rows: readonly T[], filter: InvoiceListFilter, query: string, today: string): T[] {
  return rows.filter(
    (row) => (!filter.pastDueOnly || isPastDue(row, today)) && matchesInvoiceSearch(row, query),
  );
}
