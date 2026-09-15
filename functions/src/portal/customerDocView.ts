// Customer-facing views of one invoice or quote, for the portal pages (S-08)
// and the public pay page (S-09).
//
// The detail callables return this projection rather than the stored document:
// internal fields — who created or voided it, Stripe ids, email delivery
// status, the void reason the business typed for itself — stay out, and
// Timestamps become epoch milliseconds, because a callable serializes an Admin
// SDK Timestamp as {_seconds, _nanoseconds} with no methods.
//
// The invoice view carries the pay token while the invoice can still be paid:
// the portal's Pay button opens /pay/{payToken}, the same page the email links
// to (blueprint, "Customer-facing payment creation"). Firestore rules already
// let this verified customer read the stored token, so returning it exposes
// nothing new; it is withheld once nothing is left to pay.

import { isPayableInvoiceStatus } from "../shared/invoiceStatus";

type Data = FirebaseFirestore.DocumentData;

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

/** What the document shows about the business that sent it. */
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
  /** Set while the invoice is payable; the Pay button opens /pay/{payToken}. */
  payToken: string | null;
  /** When that link stops working (the token's own expiry is authoritative). */
  payTokenExpiresAt: number | null;
}

export interface CustomerQuoteView extends CustomerDocViewBase {
  validUntil: string;
}

/** Epoch milliseconds for a Firestore Timestamp; null for anything else. */
export function toMillis(value: unknown): number | null {
  const maybe = value as { toMillis?: unknown } | null | undefined;
  return maybe && typeof maybe.toMillis === "function"
    ? (maybe.toMillis as () => number)()
    : null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function toCustomerLineItems(value: unknown): CustomerLineItemView[] {
  if (!Array.isArray(value)) return [];
  return value.map((line: Data) => ({
    description: str(line?.description),
    quantity: num(line?.quantity),
    rate: num(line?.rate),
    // Lines written before D4 carry no flag; they were taxed with the document.
    taxable: line?.taxable !== false,
    amount: num(line?.amount),
  }));
}

export function toCustomerTotals(value: unknown): CustomerTotalsView {
  const t = (value ?? {}) as Data;
  return {
    subtotal: num(t.subtotal),
    taxAmount: num(t.taxAmount),
    total: num(t.total),
    taxes: Array.isArray(t.taxes)
      ? t.taxes.map((tax: Data) => ({
          name: str(tax?.name),
          rate: num(tax?.rate),
          taxableAmount: num(tax?.taxableAmount),
          amount: num(tax?.amount),
        }))
      : [],
  };
}

export function toCustomerBusinessView(value: unknown): CustomerBusinessView {
  const s = (value ?? {}) as Data;
  return {
    name: str(s.name),
    logoUrl: strOrNull(s.logoUrl),
    address: strOrNull(s.address),
    primaryColor: str(s.primaryColor, "#667eea"),
    businessNumber: strOrNull(s.businessNumber),
    currency: str(s.currency, "CAD"),
  };
}

function base(id: string, tenantId: string, d: Data): CustomerDocViewBase {
  return {
    id,
    tenantId,
    customer: {
      name: str(d.customer?.name),
      email: str(d.customer?.email),
      phone: strOrNull(d.customer?.phone),
    },
    lineItems: toCustomerLineItems(d.lineItems),
    totals: toCustomerTotals(d.totals),
    tenantSnapshot: toCustomerBusinessView(d.tenantSnapshot),
    status: str(d.status),
    issueDate: str(d.issueDate),
    notes: strOrNull(d.notes),
    sentAt: toMillis(d.sentAt),
  };
}

export function toCustomerInvoiceView(
  id: string,
  tenantId: string,
  d: Data,
): CustomerInvoiceView {
  const payable = isPayableInvoiceStatus(d.status) && typeof d.payToken === "string";
  return {
    ...base(id, tenantId, d),
    dueDate: str(d.dueDate),
    paidAt: toMillis(d.paidAt),
    paymentMethod: strOrNull(d.paymentMethod),
    paidAmountCents: numOrNull(d.paidAmountCents),
    surchargeAmountCents: numOrNull(d.surchargeAmountCents),
    refundedAt: toMillis(d.refundedAt),
    refundedAmountCents: numOrNull(d.refundedAmountCents),
    voidedAt: toMillis(d.voidedAt),
    payToken: payable ? d.payToken : null,
    payTokenExpiresAt: payable ? toMillis(d.payTokenExpiresAt) : null,
  };
}

export function toCustomerQuoteView(
  id: string,
  tenantId: string,
  d: Data,
): CustomerQuoteView {
  return {
    ...base(id, tenantId, d),
    validUntil: str(d.validUntil),
  };
}
