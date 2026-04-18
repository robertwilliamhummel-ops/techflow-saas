// Shared recurring-invoice helpers — types, validation, schedule advancement.
//
// computeNextRunAt advances from the CURRENT scheduled date (not "now") to
// prevent drift when the processor runs late. Month-end clamping is explicit:
// anchorDay 31 → Apr 30, anchorDay 29 → Feb 28 on non-leap years, Feb 29 on
// leap years.

import { HttpsError } from "firebase-functions/v2/https";
import type { LineItemInput, CustomerInput } from "./invoice";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecurringInterval =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "annually";

export const VALID_INTERVALS: readonly RecurringInterval[] = [
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "annually",
];

export interface RecurringInvoiceInput {
  customer: CustomerInput;
  lineItems: LineItemInput[];
  applyTax: boolean;
  notes?: string | null;
  internalDescription?: string | null;
  daysUntilDue: number;
  interval: RecurringInterval;
  startDate: string; // YYYY-MM-DD
  endAfterCount?: number | null;
  endDate?: string | null;
  autoSend: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateRecurringInvoiceInput(
  data: unknown,
): RecurringInvoiceInput {
  const d = data as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== "object") {
    throw new HttpsError("invalid-argument", "Recurring invoice data required.");
  }

  // Customer — same rules as invoice
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

  // Line items — same rules as invoice
  if (!Array.isArray(d.lineItems) || d.lineItems.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "At least one line item required.",
    );
  }
  if (d.lineItems.length > 100) {
    throw new HttpsError(
      "invalid-argument",
      "Maximum 100 line items per recurring invoice.",
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

  // Notes
  const notes = d.notes != null ? String(d.notes).trim() || null : null;
  if (notes && notes.length > 2000) {
    throw new HttpsError(
      "invalid-argument",
      "notes must be ≤2000 characters.",
    );
  }

  // Internal description
  const internalDescription =
    d.internalDescription != null
      ? String(d.internalDescription).trim() || null
      : null;
  if (internalDescription && internalDescription.length > 200) {
    throw new HttpsError(
      "invalid-argument",
      "internalDescription must be ≤200 characters.",
    );
  }

  // Days until due
  const daysUntilDue = Number(d.daysUntilDue);
  if (
    !Number.isFinite(daysUntilDue) ||
    daysUntilDue < 0 ||
    !Number.isInteger(daysUntilDue)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "daysUntilDue must be a non-negative integer.",
    );
  }

  // Interval
  const interval = String(d.interval ?? "").trim() as RecurringInterval;
  if (!VALID_INTERVALS.includes(interval)) {
    throw new HttpsError(
      "invalid-argument",
      `interval must be one of: ${VALID_INTERVALS.join(", ")}.`,
    );
  }

  // Start date
  const startDate = String(d.startDate ?? "").trim();
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    throw new HttpsError(
      "invalid-argument",
      "startDate required (YYYY-MM-DD).",
    );
  }

  // End after count
  let endAfterCount: number | null = null;
  if (d.endAfterCount != null) {
    endAfterCount = Number(d.endAfterCount);
    if (
      !Number.isFinite(endAfterCount) ||
      endAfterCount < 1 ||
      !Number.isInteger(endAfterCount)
    ) {
      throw new HttpsError(
        "invalid-argument",
        "endAfterCount must be a positive integer if provided.",
      );
    }
  }

  // End date
  let endDate: string | null = null;
  if (d.endDate != null) {
    endDate = String(d.endDate).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      throw new HttpsError(
        "invalid-argument",
        "endDate must be YYYY-MM-DD if provided.",
      );
    }
  }

  // Auto send
  const autoSend = d.autoSend === true;

  return {
    customer: { name: custName, email: custEmail, phone: custPhone },
    lineItems,
    applyTax,
    notes,
    internalDescription,
    daysUntilDue,
    interval,
    startDate,
    endAfterCount,
    endDate,
    autoSend,
  };
}

// ---------------------------------------------------------------------------
// Schedule advancement
// ---------------------------------------------------------------------------

/**
 * Compute the next run date by advancing from the CURRENT scheduled date.
 * Advancing from the scheduled date (not "now") prevents drift when the
 * processor runs late.
 *
 * Month-end clamping: if anchorDay exceeds the target month's length, clamp
 * to the last day of that month. Examples:
 *   - anchorDay 31, target month April (30 days) → April 30
 *   - anchorDay 29, target month February 2027 (non-leap, 28 days) → Feb 28
 *   - anchorDay 29, target month February 2028 (leap year, 29 days) → Feb 29
 */
export function computeNextRunAt(
  current: Date,
  interval: RecurringInterval,
  anchorDay: number,
): Date {
  switch (interval) {
    case "weekly":
      return addDays(current, 7);
    case "biweekly":
      return addDays(current, 14);
    case "monthly":
      return advanceMonths(current, 1, anchorDay);
    case "quarterly":
      return advanceMonths(current, 3, anchorDay);
    case "annually":
      return advanceMonths(current, 12, anchorDay);
  }
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/**
 * Advance by N months, clamping the day to the target month's length.
 *
 * Leap-year handling is explicit:
 *   daysInMonth(2027, 1) → 28  (non-leap February)
 *   daysInMonth(2028, 1) → 29  (leap-year February)
 * If anchorDay is 29 and the target is Feb 2027, the result is Feb 28.
 * If anchorDay is 29 and the target is Feb 2028, the result is Feb 29.
 */
function advanceMonths(date: Date, months: number, anchorDay: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  // Let Date handle year rollover (e.g., month 13 → next year Jan).
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = month % 12;
  const lastDay = daysInMonth(targetYear, targetMonth);
  // Clamp anchorDay to the last valid day of the target month.
  // This is where Feb 29 → Feb 28 (non-leap) clamping happens.
  const day = Math.min(anchorDay, lastDay);
  return new Date(Date.UTC(targetYear, targetMonth, day));
}

/**
 * Returns the number of days in the given month (0-indexed).
 * Leap years are handled by the Date constructor:
 *   - Feb 2028 (leap): 29 days
 *   - Feb 2027 (non-leap): 28 days
 */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the NEXT month = last day of THIS month.
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Compute the next future run date from today for reactivation (paused → active).
 * For monthly/quarterly/annually: finds the next anchorDay occurrence after `now`.
 * For weekly/biweekly: returns now + interval days.
 */
export function computeNextFutureRunAt(
  now: Date,
  interval: RecurringInterval,
  anchorDay: number,
): Date {
  switch (interval) {
    case "weekly":
      return addDays(now, 7);
    case "biweekly":
      return addDays(now, 14);
    case "monthly":
    case "quarterly":
    case "annually": {
      // Try anchorDay this month first.
      const lastDay = daysInMonth(now.getUTCFullYear(), now.getUTCMonth());
      const day = Math.min(anchorDay, lastDay);
      const candidate = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day),
      );
      if (candidate > now) return candidate;
      // Already passed this month — advance by one period.
      const months =
        interval === "monthly" ? 1 : interval === "quarterly" ? 3 : 12;
      return advanceMonths(candidate, months, anchorDay);
    }
  }
}

/**
 * Add daysUntilDue to an ISO date string and return a new ISO date string.
 */
export function addDaysToISODate(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Extract the day-of-month from an ISO date string for use as anchorDay.
 */
export function extractAnchorDay(isoDate: string): number {
  return new Date(isoDate + "T00:00:00Z").getUTCDate();
}
