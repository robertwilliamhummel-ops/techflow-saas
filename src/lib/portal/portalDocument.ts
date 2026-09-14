// Portal invoice and quote pages (S-08): the customer views the detail
// callables return (functions/src/portal/customerDocView.ts) and what each page
// offers for them. Pure, so the rules are tested without rendering.

import {
  balanceDueCents,
  daysPastDue,
  displayInvoiceStatus,
  isPastDue,
  isPayableStatus,
} from "@/lib/invoices/dueStatus";
import {
  isCustomerVisibleInvoiceStatus,
  isCustomerVisibleQuoteStatus,
} from "@/lib/portal/customerVisibility";
import { displayQuoteStatus } from "@/lib/quotes/quoteStatus";
import type { InvoiceStatus, QuoteStatus } from "@/lib/schema/tenant";

// The same shapes as functions/src/portal/customerDocView.ts; a type test pins
// the two together. Times are epoch milliseconds.

export interface CustomerLineItemView {
  description: string;
  quantity: number;
  rate: number;
  taxable: boolean;
  amount: number;
}

export interface CustomerTaxLineView {
  name: string;
  rate: number;
  taxableAmount: number;
  amount: number;
}

export interface CustomerTotalsView {
  subtotal: number;
  taxAmount: number;
  total: number;
  taxes: CustomerTaxLineView[];
}

export interface CustomerBusinessView {
  name: string;
  logoUrl: string | null;
  address: string | null;
  primaryColor: string;
  businessNumber: string | null;
  currency: string;
}

interface CustomerDocViewBase {
  id: string;
  tenantId: string;
  customer: { name: string; email: string; phone: string | null };
  lineItems: CustomerLineItemView[];
  totals: CustomerTotalsView;
  tenantSnapshot: CustomerBusinessView;
  status: string;
  issueDate: string;
  notes: string | null;
  sentAt: number | null;
}

export interface CustomerInvoiceView extends CustomerDocViewBase {
  dueDate: string;
  paidAt: number | null;
  paymentMethod: string | null;
  paidAmountCents: number | null;
  surchargeAmountCents: number | null;
  refundedAt: number | null;
  refundedAmountCents: number | null;
  voidedAt: number | null;
  payToken: string | null;
  payTokenExpiresAt: number | null;
}

export interface CustomerQuoteView extends CustomerDocViewBase {
  validUntil: string;
}

const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** requireDocId's rule: one path segment and not a reserved __name__ id. */
export function isDocId(value: unknown): value is string {
  return typeof value === "string" && DOC_ID.test(value) && !/^__.*__$/.test(value);
}

export type PortalPayAction =
  /** Opens the pay page, the same one the invoice email links to. */
  | { kind: "pay"; href: string; expiresAt: number | null }
  /** The link ran out; only the business can issue a new one. */
  | { kind: "link-expired" }
  /** Nothing to pay, or no link to pay with. */
  | null;

export interface PortalInvoiceState {
  /** The status to show — a sent or unpaid invoice past its due date is overdue. */
  status: InvoiceStatus;
  /** Something is still owed on it. */
  payable: boolean;
  /** Still owed, in cents; 0 once nothing is left to pay. */
  balanceCents: number;
  /** Whole days past due; 0 unless payable and past due. */
  daysOverdue: number;
  pay: PortalPayAction;
}

/** What the invoice page shows and offers; null for a status customers don't see. */
export function portalInvoiceState(
  invoice: CustomerInvoiceView,
  today: string,
  nowMs: number,
): PortalInvoiceState | null {
  const stored = invoice.status;
  if (!isCustomerVisibleInvoiceStatus(stored)) return null;
  if (!isPayableStatus(stored)) {
    return { status: stored, payable: false, balanceCents: 0, daysOverdue: 0, pay: null };
  }

  const fields = { status: stored, dueDate: invoice.dueDate };
  let pay: PortalPayAction = null;
  if (invoice.payToken) {
    const expired =
      invoice.payTokenExpiresAt !== null && invoice.payTokenExpiresAt <= nowMs;
    pay = expired
      ? { kind: "link-expired" }
      : { kind: "pay", href: payHref(invoice.payToken), expiresAt: invoice.payTokenExpiresAt };
  }

  return {
    status: displayInvoiceStatus(fields, today),
    payable: true,
    balanceCents: balanceDueCents({
      status: stored,
      totals: invoice.totals,
      paidAmountCents: invoice.paidAmountCents,
    }),
    daysOverdue: isPastDue(fields, today) ? daysPastDue(invoice.dueDate, today) : 0,
    pay,
  };
}

/** The status the quote page shows; null for a status customers don't see. */
export function portalQuoteStatus(
  quote: CustomerQuoteView,
  today: string,
): QuoteStatus | null {
  const stored = quote.status;
  if (!isCustomerVisibleQuoteStatus(stored)) return null;
  return displayQuoteStatus({ status: stored, validUntil: quote.validUntil }, today);
}

export function payHref(payToken: string): string {
  return `/pay/${encodeURIComponent(payToken)}`;
}

/** The PDF route for one document; it needs the viewer's ID token. */
export function portalPdfHref(
  kind: "invoice" | "quote",
  tenantId: string,
  id: string,
): string {
  const query = new URLSearchParams(
    kind === "invoice" ? { tenantId, invoiceId: id } : { tenantId, quoteId: id },
  );
  return `/api/pdf/${kind}?${query}`;
}

/** A tax rate as a percentage, keeping rates such as QST's 9.975%. */
export function formatTaxRate(rate: number): string {
  return `${Math.round(rate * 100_000) / 1_000}%`;
}

export type PortalLoadError = "not-found" | "failed";

/**
 * How to explain a failed detail call. Someone else's document, a malformed
 * link, and a document that doesn't exist all read as not found, so a page never
 * confirms that another customer's invoice exists.
 */
export function portalLoadError(err: unknown): PortalLoadError {
  const code = (err as { code?: unknown } | null)?.code;
  const bare = typeof code === "string" ? code.replace(/^functions\//, "") : "";
  return bare === "not-found" || bare === "permission-denied" || bare === "invalid-argument"
    ? "not-found"
    : "failed";
}
