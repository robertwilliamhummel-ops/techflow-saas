// Display formatting shared by dashboard and portal screens. Invoices store
// dollars rounded to cents; screens add up cents so totals never drift.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function dollarsToCents(amount: number): number {
  return Math.round(amount * 100);
}

/** `$1,234.56` for CAD and `US$1,234.56` for USD (en-CA). */
export function formatMoneyCents(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/** A Firestore Timestamp as a date and time in the viewer's time zone. */
export function formatTimestamp(
  value: { toDate(): Date } | null | undefined,
): string | null {
  if (!value || typeof value.toDate !== "function") return null;
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value.toDate());
}

/** Epoch milliseconds (as the portal detail callables send times) as a date in the viewer's time zone. */
export function formatDateMillis(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" }).format(ms);
}

/**
 * A YYYY-MM-DD calendar date as a short readable date. Formatted in UTC so the
 * viewer's time zone can't move it a day; anything else is returned unchanged.
 */
export function formatIsoDate(iso: string): string {
  const match = ISO_DATE.exec(iso);
  if (!match) return iso;
  const [, y, m, d] = match;
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}
