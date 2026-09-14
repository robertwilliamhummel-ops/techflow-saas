// Shared invoice helpers — validation, totals computation, tenant snapshot builder.
//
// Every invoice/quote mutation uses these. Server-side totals computation is
// mandatory — client math is never trusted (blueprint Phase 2).

import { HttpsError } from "firebase-functions/v2/https";
import type { Timestamp, FieldValue } from "firebase-admin/firestore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// D4 — every line carries its own taxability. Mixed invoices (e.g. a taxable
// cleaning + an HST-exempt exam) are first-class; `applyTax` on the document is
// only the default for lines that don't specify.
export interface LineItemInput {
  description: string;
  quantity: number;
  rate: number;
  taxable: boolean;
}

export interface LineItem extends LineItemInput {
  amount: number; // server-computed: quantity * rate
}

export interface TaxLine {
  name: string; // e.g. "HST"
  rate: number; // fraction, e.g. 0.13
  taxableAmount: number; // base this tax applied to
  amount: number;
}

export interface CustomerInput {
  name: string;
  email: string;
  phone?: string | null;
}

export interface InvoiceInput {
  customer: CustomerInput;
  lineItems: LineItemInput[];
  applyTax: boolean;
  dueDate: string; // ISO-8601 date string
  issueDate?: string | null; // defaults to today
  notes?: string | null;
}

// `taxes[]` is the authoritative breakdown (one entry per tax, so GST+PST/QST
// provinces are an additive change later). `taxRate`/`taxAmount` remain as the
// aggregate for list views and older consumers.
export interface InvoiceTotals {
  subtotal: number;
  taxableSubtotal: number;
  taxRate: number;
  taxAmount: number;
  taxes: TaxLine[];
  total: number;
}

export interface TenantSnapshot {
  version: number;
  name: string;
  // A-06/D7: token URL of the immutable Storage copy of the logo and its MIME
  // type; null when there is no logo. Emails and the portal use the URL; PDF
  // renders inline it (pdfLogoDataUrl). No base64 copy is stored.
  logoUrl: string | null;
  logoContentType: string | null;
  address: string | null;
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  faviconUrl: string | null;
  taxRate: number;
  taxName: string;
  businessNumber: string | null;
  emailFooter: string | null;
  currency: string;
  chargeCustomerCardFees: boolean;
  cardFeePercent: number;
  etransferEmail: string | null;
}

export type InvoiceStatus =
  | "draft"
  | "sent"
  | "unpaid"
  | "overdue"
  | "partial"
  | "paid"
  | "refunded"
  | "partially-refunded"
  | "void"; // A-12 — issued, then cancelled; final (voidInvoice)

export type ManualPaymentMethod = "manual" | "etransfer" | "cash";

export interface InvoiceDoc {
  customer: { name: string; email: string; phone: string | null };
  lineItems: LineItem[];
  applyTax: boolean;
  totals: InvoiceTotals;
  tenantSnapshot: TenantSnapshot;
  status: InvoiceStatus;
  dueDate: string;
  issueDate: string;
  notes: string | null;
  payToken: string;
  payTokenExpiresAt: Timestamp | FieldValue;
  payTokenVersion: number;
  createdAt: Timestamp | FieldValue;
  createdBy: string;
  paidAt?: Timestamp | FieldValue | null;
  paymentMethod?: ManualPaymentMethod | "card" | null;
  sourceQuoteId?: string | null;
  sourceRecurringInvoiceId?: string | null;
  // A-12 — set by voidInvoice.
  voidedAt?: Timestamp | FieldValue | null;
  voidedBy?: string | null;
  voidReason?: string | null;

  // Stripe payment reconciliation — written by the Connect webhook.
  // paidAmountCents + surchargeAmountCents split is preserved so accounting
  // can reconcile "invoice was $500, surcharge was $12, tenant received $512".
  paidAmountCents?: number | null;
  surchargeAmountCents?: number | null;
  // A-02: refund and dispute events find the invoice by PaymentIntent id.
  stripePaymentIntentId?: string | null;
  stripeCheckoutSessionId?: string | null;

  // Refund fields — set by charge.refunded. Partial vs full distinguished via
  // status ('refunded' vs 'partially-refunded'). paidAmountCents is NOT cleared
  // so historic records survive.
  refundedAt?: Timestamp | FieldValue | null;
  refundedAmountCents?: number | null;

  // Dispute fields — set by charge.dispute.created / closed. `disputed` stays
  // true while the dispute is open; `disputeOutcome` is set when it closes.
  disputed?: boolean;
  disputedAt?: Timestamp | FieldValue | null;
  disputeReason?: string | null;
  disputeOutcome?: "won" | "lost" | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateInvoiceInput(data: unknown): InvoiceInput {
  const d = data as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== "object") {
    throw new HttpsError("invalid-argument", "Invoice data required.");
  }

  // Customer
  const cust = d.customer as Record<string, unknown> | null | undefined;
  if (!cust || typeof cust !== "object") {
    throw new HttpsError("invalid-argument", "customer object required.");
  }
  const custName = String(cust.name ?? "").trim();
  if (!custName || custName.length > 200) {
    throw new HttpsError(
      "invalid-argument",
      "customer.name must be 1–200 characters.",
    );
  }
  const custEmail = String(cust.email ?? "").trim();
  if (!custEmail) {
    throw new HttpsError("invalid-argument", "customer.email required.");
  }
  const custPhone =
    cust.phone != null ? String(cust.phone).trim() || null : null;

  // Tax default — each line may override with its own `taxable` (D4).
  const applyTax = d.applyTax === true;
  const lineItems = validateLineItems(d.lineItems, applyTax, "invoice");

  // Dates
  const dueDate = String(d.dueDate ?? "").trim();
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new HttpsError(
      "invalid-argument",
      "dueDate required (YYYY-MM-DD).",
    );
  }
  const issueDate =
    d.issueDate != null ? String(d.issueDate).trim() || null : null;
  if (issueDate && !/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    throw new HttpsError(
      "invalid-argument",
      "issueDate must be YYYY-MM-DD if provided.",
    );
  }

  // Notes
  const notes = d.notes != null ? String(d.notes).trim() || null : null;
  if (notes && notes.length > 2000) {
    throw new HttpsError(
      "invalid-argument",
      "notes must be ≤2000 characters.",
    );
  }

  return {
    customer: { name: custName, email: custEmail, phone: custPhone },
    lineItems,
    applyTax,
    dueDate,
    issueDate,
    notes,
  };
}

// Shared by invoice, quote, and recurring-template validation. A line without
// a `taxable` flag inherits the document's `applyTax` default.
export function validateLineItems(
  raw: unknown,
  applyTax: boolean,
  docLabel: "invoice" | "quote" | "recurring invoice",
): LineItemInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "At least one line item required.",
    );
  }
  if (raw.length > 100) {
    throw new HttpsError(
      "invalid-argument",
      `Maximum 100 line items per ${docLabel}.`,
    );
  }
  return raw.map((item: unknown, i: number) => {
    const li = item as Record<string, unknown>;
    if (!li || typeof li !== "object") {
      throw new HttpsError(
        "invalid-argument",
        `lineItems[${i}] must be an object.`,
      );
    }
    const desc = String(li.description ?? "").trim();
    if (!desc || desc.length > 500) {
      throw new HttpsError(
        "invalid-argument",
        `lineItems[${i}].description must be 1–500 characters.`,
      );
    }
    const qty = Number(li.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new HttpsError(
        "invalid-argument",
        `lineItems[${i}].quantity must be a positive number.`,
      );
    }
    const rate = Number(li.rate);
    if (!Number.isFinite(rate) || rate < 0) {
      throw new HttpsError(
        "invalid-argument",
        `lineItems[${i}].rate must be a non-negative number.`,
      );
    }
    if (li.taxable != null && typeof li.taxable !== "boolean") {
      throw new HttpsError(
        "invalid-argument",
        `lineItems[${i}].taxable must be a boolean if provided.`,
      );
    }
    const taxable = typeof li.taxable === "boolean" ? li.taxable : applyTax;
    return { description: desc, quantity: qty, rate, taxable };
  });
}

// Line items read back from a stored quote or recurring template. Lines saved
// without a flag inherit the document's applyTax.
export function resolveLineItems(
  stored: unknown,
  applyTax: boolean,
): LineItemInput[] {
  if (!Array.isArray(stored)) return [];
  return stored.map((item) => {
    const li = item as Record<string, unknown>;
    return {
      description: String(li.description ?? ""),
      quantity: Number(li.quantity ?? 0),
      rate: Number(li.rate ?? 0),
      taxable: typeof li.taxable === "boolean" ? li.taxable : applyTax,
    };
  });
}

// ---------------------------------------------------------------------------
// Totals computation — server-authoritative, never trust client math
// ---------------------------------------------------------------------------

export function computeInvoiceTotals(
  lineItems: LineItemInput[],
  tax: { rate: number; name: string },
): InvoiceTotals {
  let subtotal = 0;
  let taxableSubtotal = 0;
  for (const li of lineItems) {
    const amount = roundCents(li.quantity * li.rate);
    subtotal += amount;
    if (li.taxable) taxableSubtotal += amount;
  }
  subtotal = roundCents(subtotal);
  taxableSubtotal = roundCents(taxableSubtotal);

  const rate = Number.isFinite(tax.rate) && tax.rate > 0 ? tax.rate : 0;
  const taxAmount =
    rate > 0 && taxableSubtotal > 0 ? roundCents(taxableSubtotal * rate) : 0;
  const taxes: TaxLine[] =
    taxAmount > 0
      ? [
          {
            name: tax.name || "Tax",
            rate,
            taxableAmount: taxableSubtotal,
            amount: taxAmount,
          },
        ]
      : [];

  return {
    subtotal,
    taxableSubtotal,
    taxRate: taxAmount > 0 ? rate : 0,
    taxAmount,
    taxes,
    total: roundCents(subtotal + taxAmount),
  };
}

export function computeLineItems(inputs: LineItemInput[]): LineItem[] {
  return inputs.map((li) => ({
    ...li,
    amount: roundCents(li.quantity * li.rate),
  }));
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Tenant snapshot builder — freezes branding at invoice creation time
// ---------------------------------------------------------------------------

// `features.cardSurcharge` (D3) gates the frozen surcharge flag: while the
// platform flag is off, no invoice can be created that discloses or charges a
// card fee, whatever the tenant's saved payment settings say.
export function buildTenantSnapshot(
  meta: Record<string, unknown>,
  features: { cardSurcharge: boolean },
): TenantSnapshot {
  return {
    version: 1,
    name: String(meta.name ?? ""),
    // Caller fills both via applyLogoToSnapshot when meta.logoUrl is set.
    logoUrl: null,
    logoContentType: null,
    address: meta.address != null ? String(meta.address) : null,
    primaryColor: String(meta.primaryColor ?? "#667eea"),
    secondaryColor: String(meta.secondaryColor ?? "#764ba2"),
    fontFamily: String(meta.fontFamily ?? "Inter"),
    faviconUrl: meta.faviconUrl != null ? String(meta.faviconUrl) : null,
    taxRate: Number(meta.taxRate ?? 0),
    taxName: String(meta.taxName ?? ""),
    businessNumber:
      meta.businessNumber != null ? String(meta.businessNumber) : null,
    emailFooter: meta.emailFooter != null ? String(meta.emailFooter) : null,
    currency: String(meta.currency ?? "CAD"),
    chargeCustomerCardFees:
      features.cardSurcharge && meta.chargeCustomerCardFees === true,
    cardFeePercent: Number(meta.cardFeePercent ?? 0),
    etransferEmail:
      meta.etransferEmail != null ? String(meta.etransferEmail) : null,
  };
}

// Logo snapshot helpers live in ./logo (A-06); re-exported for existing imports.
export { LOGO_MAX_BYTES, inlineLogoOrThrow } from "./logo";
