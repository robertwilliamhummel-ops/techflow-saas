// Calendar dates on invoices, quotes, and recurring templates are YYYY-MM-DD
// strings. The pattern alone accepts 2026-02-31, so the parts must also
// round-trip through a real UTC date.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC maps years 0–99 to 1900–1999, which also fails this check.
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
