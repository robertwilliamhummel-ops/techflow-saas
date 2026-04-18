// Shared invoice helpers — validation, totals computation, tenant snapshot builder.
//
// Every invoice/quote mutation uses these. Server-side totals computation is
// mandatory — client math is never trusted (blueprint Phase 2).

import { HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import type { Timestamp, FieldValue } from "firebase-admin/firestore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LineItemInput {
  description: string;
  quantity: number;
  rate: number;
}

export interface LineItem extends LineItemInput {
  amount: number; // server-computed: quantity * rate
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

export interface InvoiceTotals {
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
}

export interface TenantSnapshot {
  version: number;
  name: string;
  logo: string | null; // base64 data URL (inlined at creation) or null
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
  | "partially-refunded";

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
  paymentMethod?: ManualPaymentMethod | "stripe" | null;
  sourceQuoteId?: string | null;
  sourceRecurringInvoiceId?: string | null;
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

  // Line items
  if (!Array.isArray(d.lineItems) || d.lineItems.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "At least one line item required.",
    );
  }
  if (d.lineItems.length > 100) {
    throw new HttpsError(
      "invalid-argument",
      "Maximum 100 line items per invoice.",
    );
  }
  const lineItems: LineItemInput[] = d.lineItems.map(
    (item: unknown, i: number) => {
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
      return { description: desc, quantity: qty, rate };
    },
  );

  // Tax flag
  const applyTax = d.applyTax === true;

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

// ---------------------------------------------------------------------------
// Totals computation — server-authoritative, never trust client math
// ---------------------------------------------------------------------------

export function computeInvoiceTotals(
  lineItems: LineItemInput[],
  taxRate: number,
  applyTax: boolean,
): InvoiceTotals {
  const subtotal = lineItems.reduce(
    (sum, li) => sum + roundCents(li.quantity * li.rate),
    0,
  );
  const taxAmount = applyTax ? roundCents(subtotal * taxRate) : 0;
  const total = roundCents(subtotal + taxAmount);
  return { subtotal, taxRate: applyTax ? taxRate : 0, taxAmount, total };
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

export function buildTenantSnapshot(
  meta: Record<string, unknown>,
): TenantSnapshot {
  return {
    version: 1,
    name: String(meta.name ?? ""),
    logo: null, // Phase 6: inlineLogoOrThrow — logo inlining deferred until Cloud Run exists
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
    chargeCustomerCardFees: meta.chargeCustomerCardFees === true,
    cardFeePercent: Number(meta.cardFeePercent ?? 0),
    etransferEmail:
      meta.etransferEmail != null ? String(meta.etransferEmail) : null,
  };
}

// ---------------------------------------------------------------------------
// Logo inlining — fetches the logo URL and converts to a base64 data URL
// so the invoice survives future logo rotations/deletions.
// Phase 6 will move this to a more robust implementation once Cloud Run exists.
// ---------------------------------------------------------------------------

export async function inlineLogoOrNull(
  logoUrl: string | null | undefined,
): Promise<string | null> {
  if (!logoUrl) return null;
  try {
    const res = await fetch(logoUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      logger.warn("Logo fetch failed", { logoUrl, status: res.status });
      return null;
    }
    const contentType = res.headers.get("content-type") ?? "image/png";
    const buffer = Buffer.from(await res.arrayBuffer());
    // Cap at 500KB — anything larger is an unreasonable logo
    if (buffer.byteLength > 500_000) {
      logger.warn("Logo too large, skipping inline", {
        logoUrl,
        bytes: buffer.byteLength,
      });
      return null;
    }
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  } catch (err) {
    logger.warn("Logo inline failed", { logoUrl, error: String(err) });
    return null;
  }
}
