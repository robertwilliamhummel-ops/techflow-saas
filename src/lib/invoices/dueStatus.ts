// Read-time due status for invoices (blueprint Phase 1.5, "Status badge
// mapping"). Nothing stores `overdue` — no job flips it — so screens derive it
// from `dueDate`. PAYABLE_INVOICE_STATUSES mirrors
// functions/src/shared/invoiceStatus.ts; a test pins the two together.

import type {
  CurrencyCode,
  Invoice,
  InvoiceStatus,
} from "@/lib/schema/tenant";

export const PAYABLE_INVOICE_STATUSES = [
  "sent",
  "unpaid",
  "overdue",
  "partial",
] as const satisfies readonly InvoiceStatus[];

// Shown as overdue once past due. A partial invoice keeps its own badge (the
// customer has paid something) but still counts toward overdue totals.
const SHOWN_AS_OVERDUE: readonly InvoiceStatus[] = ["sent", "unpaid"];

const DAY_MS = 86_400_000;

export type DueFields = Pick<Invoice, "status" | "dueDate">;
export type BalanceFields = Pick<Invoice, "status" | "totals" | "paidAmountCents">;
export type ReceivableInvoice = DueFields &
  BalanceFields & { tenantSnapshot: { currency: CurrencyCode } };

export function isPayableStatus(status: InvoiceStatus): boolean {
  return (PAYABLE_INVOICE_STATUSES as readonly InvoiceStatus[]).includes(status);
}

/** A date in the viewer's time zone as YYYY-MM-DD, the format of `dueDate`. */
export function localIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Payable and past its due date. An invoice due today is not overdue yet. */
export function isPastDue(invoice: DueFields, today: string): boolean {
  if (!isPayableStatus(invoice.status)) return false;
  // YYYY-MM-DD strings sort in date order.
  return invoice.status === "overdue" || invoice.dueDate < today;
}

/** The status to show: a sent or unpaid invoice past its due date is overdue. */
export function displayInvoiceStatus(
  invoice: DueFields,
  today: string,
): InvoiceStatus {
  return SHOWN_AS_OVERDUE.includes(invoice.status) && isPastDue(invoice, today)
    ? "overdue"
    : invoice.status;
}

/** Whole days between the due date and today; 0 when not yet due. */
export function daysPastDue(dueDate: string, today: string): number {
  return Math.max(0, Math.round((isoDateToUtc(today) - isoDateToUtc(dueDate)) / DAY_MS));
}

function isoDateToUtc(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** What the customer still owes, in cents. */
export function balanceDueCents(invoice: BalanceFields): number {
  const totalCents = Math.round(invoice.totals.total * 100);
  if (invoice.status !== "partial") return totalCents;
  return Math.max(0, totalCents - (invoice.paidAmountCents ?? 0));
}

export interface ReceivablesSummary {
  currency: CurrencyCode;
  outstandingCents: number;
  outstandingCount: number;
  overdueCents: number;
  overdueCount: number;
}

/**
 * Outstanding and overdue balances per currency — amounts in different
 * currencies are never added together. The preferred currency (the tenant's
 * current one) comes first, and is always present so a tenant with nothing
 * owed still sees a zero.
 */
export function summarizeReceivables(
  invoices: readonly ReceivableInvoice[],
  today: string,
  preferredCurrency: CurrencyCode,
): ReceivablesSummary[] {
  const byCurrency = new Map<CurrencyCode, ReceivablesSummary>();
  const entry = (currency: CurrencyCode): ReceivablesSummary => {
    let summary = byCurrency.get(currency);
    if (!summary) {
      summary = {
        currency,
        outstandingCents: 0,
        outstandingCount: 0,
        overdueCents: 0,
        overdueCount: 0,
      };
      byCurrency.set(currency, summary);
    }
    return summary;
  };

  entry(preferredCurrency);
  for (const invoice of invoices) {
    if (!isPayableStatus(invoice.status)) continue;
    const summary = entry(invoice.tenantSnapshot.currency);
    const balance = balanceDueCents(invoice);
    summary.outstandingCents += balance;
    summary.outstandingCount += 1;
    if (isPastDue(invoice, today)) {
      summary.overdueCents += balance;
      summary.overdueCount += 1;
    }
  }

  return [...byCurrency.values()].sort((a, b) => {
    if (a.currency === preferredCurrency) return -1;
    if (b.currency === preferredCurrency) return 1;
    return a.currency.localeCompare(b.currency);
  });
}
