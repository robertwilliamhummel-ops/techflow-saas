// Shared quote helpers — validation and types.
//
// Quotes mirror invoices structurally but have no pay token and use a
// separate status set. Line item / totals / snapshot logic is shared
// with invoices via shared/invoice.ts.

import { HttpsError } from "firebase-functions/v2/https";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuoteStatus =
  | "draft"
  | "sent"
  | "accepted"
  | "declined"
  | "expired"
  | "converted";

export interface QuoteInput {
  customer: { name: string; email: string; phone?: string | null };
  lineItems: Array<{ description: string; quantity: number; rate: number }>;
  applyTax: boolean;
  validUntil: string; // ISO-8601 date string
  issueDate?: string | null;
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateQuoteInput(data: unknown): QuoteInput {
  const d = data as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== "object") {
    throw new HttpsError("invalid-argument", "Quote data required.");
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
      "Maximum 100 line items per quote.",
    );
  }
  const lineItems = d.lineItems.map((item: unknown, i: number) => {
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
  });

  // Tax flag
  const applyTax = d.applyTax === true;

  // Dates
  const validUntil = String(d.validUntil ?? "").trim();
  if (!validUntil || !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
    throw new HttpsError(
      "invalid-argument",
      "validUntil required (YYYY-MM-DD).",
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
    validUntil,
    issueDate,
    notes,
  };
}
