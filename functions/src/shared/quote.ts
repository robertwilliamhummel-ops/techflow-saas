// Shared quote helpers — validation and types.
//
// Quotes mirror invoices structurally but have no pay token and use a
// separate status set. Line item / totals / snapshot logic is shared
// with invoices via shared/invoice.ts.

import { HttpsError } from "firebase-functions/v2/https";
import { isIsoCalendarDate } from "./dates";
import { isValidEmail } from "./email";
import { validateLineItems, type LineItemInput } from "./invoice";

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
  lineItems: LineItemInput[];
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
  if (!isValidEmail(custEmail)) {
    throw new HttpsError(
      "invalid-argument",
      "customer.email must be a valid email address.",
    );
  }
  const custPhone =
    cust.phone != null ? String(cust.phone).trim() || null : null;

  // Tax default — each line may override with its own `taxable` (D4).
  const applyTax = d.applyTax === true;
  const lineItems = validateLineItems(d.lineItems, applyTax, "quote");

  // Dates — real calendar dates, and never valid until before issued.
  const validUntil = String(d.validUntil ?? "").trim();
  if (!validUntil) {
    throw new HttpsError(
      "invalid-argument",
      "validUntil required (YYYY-MM-DD).",
    );
  }
  if (!isIsoCalendarDate(validUntil)) {
    throw new HttpsError(
      "invalid-argument",
      "validUntil must be a real date (YYYY-MM-DD).",
    );
  }
  const issueDate =
    d.issueDate != null ? String(d.issueDate).trim() || null : null;
  if (issueDate && !isIsoCalendarDate(issueDate)) {
    throw new HttpsError(
      "invalid-argument",
      "issueDate must be a real date (YYYY-MM-DD) if provided.",
    );
  }
  if (issueDate && validUntil < issueDate) {
    throw new HttpsError(
      "invalid-argument",
      "validUntil can't be before issueDate.",
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
