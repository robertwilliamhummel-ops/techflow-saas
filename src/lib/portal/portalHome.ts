// Portal home (S-07): what a signed-in customer owes and has been sent, across
// every business that bills them. Pure, so the grouping is tested without
// rendering. Overdue and expired are derived at read time, the way the
// dashboard derives them (dueStatus.ts, quoteStatus.ts).

import {
  balanceDueCents,
  daysPastDue,
  displayInvoiceStatus,
  isPastDue,
  isPayableStatus,
} from "@/lib/invoices/dueStatus";
import type {
  CustomerInvoiceListItem,
  CustomerQuoteListItem,
} from "@/lib/portal/CustomerPortalContext";
import {
  isCustomerVisibleInvoiceStatus,
  isCustomerVisibleQuoteStatus,
} from "@/lib/portal/customerVisibility";
import { displayQuoteStatus } from "@/lib/quotes/quoteStatus";
import type { InvoiceStatus, QuoteStatus } from "@/lib/schema/tenant";

export interface PortalInvoiceRow {
  invoice: CustomerInvoiceListItem;
  /** The status to show — a sent or unpaid invoice past its due date is overdue. */
  status: InvoiceStatus;
  /** Still owed, in cents; 0 for an invoice with nothing left to pay. */
  balanceCents: number;
  /** Whole days past due; 0 unless payable and past due. */
  daysOverdue: number;
}

export interface PortalQuoteRow {
  quote: CustomerQuoteListItem;
  /** The status to show — a sent quote past its valid-until date is expired. */
  status: QuoteStatus;
}

export interface PortalBalance {
  currency: string;
  owedCents: number;
  count: number;
  overdueCents: number;
  overdueCount: number;
}

export interface PortalHome {
  /** Invoices with something left to pay, past due first, then soonest due. */
  toPay: PortalInvoiceRow[];
  /** What is owed per currency; amounts in different currencies never add up. */
  balances: PortalBalance[];
  /** Quotes still open, soonest to expire first. */
  openQuotes: PortalQuoteRow[];
  /** Paid, refunded and void invoices, newest first. */
  pastInvoices: PortalInvoiceRow[];
  /** Accepted, declined, expired and converted quotes, newest first. */
  pastQuotes: PortalQuoteRow[];
}

/**
 * Groups the portal lists for the home page. `invoices` and `quotes` arrive
 * newest first (getCustomerInvoices / getCustomerQuotes); a row with a status
 * customers don't see is left out.
 */
export function buildPortalHome(
  invoices: readonly CustomerInvoiceListItem[],
  quotes: readonly CustomerQuoteListItem[],
  today: string,
): PortalHome {
  const toPay: PortalInvoiceRow[] = [];
  const pastInvoices: PortalInvoiceRow[] = [];

  for (const invoice of invoices) {
    const stored = invoice.status;
    if (!isCustomerVisibleInvoiceStatus(stored)) continue;
    if (!isPayableStatus(stored)) {
      pastInvoices.push({ invoice, status: stored, balanceCents: 0, daysOverdue: 0 });
      continue;
    }
    const fields = { status: stored, dueDate: invoice.dueDate };
    toPay.push({
      invoice,
      status: displayInvoiceStatus(fields, today),
      balanceCents: balanceDueCents({
        status: stored,
        totals: invoice.totals,
        paidAmountCents: invoice.paidAmountCents,
      }),
      daysOverdue: isPastDue(fields, today) ? daysPastDue(invoice.dueDate, today) : 0,
    });
  }

  // Stable sort: past due first, then by due date; ties keep newest first.
  toPay.sort((a, b) => {
    const aLate = a.status === "overdue" || a.daysOverdue > 0 ? 0 : 1;
    const bLate = b.status === "overdue" || b.daysOverdue > 0 ? 0 : 1;
    if (aLate !== bLate) return aLate - bLate;
    return a.invoice.dueDate.localeCompare(b.invoice.dueDate);
  });

  const byCurrency = new Map<string, PortalBalance>();
  for (const row of toPay) {
    const currency = row.invoice.currency;
    const balance = byCurrency.get(currency) ?? {
      currency,
      owedCents: 0,
      count: 0,
      overdueCents: 0,
      overdueCount: 0,
    };
    balance.owedCents += row.balanceCents;
    balance.count += 1;
    if (row.status === "overdue" || row.daysOverdue > 0) {
      balance.overdueCents += row.balanceCents;
      balance.overdueCount += 1;
    }
    byCurrency.set(currency, balance);
  }
  const balances = [...byCurrency.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );

  const openQuotes: PortalQuoteRow[] = [];
  const pastQuotes: PortalQuoteRow[] = [];
  for (const quote of quotes) {
    const stored = quote.status;
    if (!isCustomerVisibleQuoteStatus(stored)) continue;
    const status = displayQuoteStatus({ status: stored, validUntil: quote.validUntil }, today);
    (status === "sent" ? openQuotes : pastQuotes).push({ quote, status });
  }
  openQuotes.sort((a, b) => a.quote.validUntil.localeCompare(b.quote.validUntil));

  return { toPay, balances, openQuotes, pastInvoices, pastQuotes };
}

/** The portal invoice page; the id alone can't locate an invoice (blueprint, magic link flow). */
export function portalInvoiceHref(
  invoice: Pick<CustomerInvoiceListItem, "id" | "tenantId">,
): string {
  const query = new URLSearchParams({ tenantId: invoice.tenantId });
  return `/portal/invoices/${encodeURIComponent(invoice.id)}?${query}`;
}

export function portalQuoteHref(
  quote: Pick<CustomerQuoteListItem, "id" | "tenantId">,
): string {
  const query = new URLSearchParams({ tenantId: quote.tenantId });
  return `/portal/quotes/${encodeURIComponent(quote.id)}?${query}`;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
export const PORTAL_FALLBACK_ACCENT = "#475569";

/** A business's brand colour when it is a #rrggbb hex, else a neutral slate. */
export function portalAccent(color: string | null | undefined): string {
  return typeof color === "string" && HEX_COLOR.test(color) ? color : PORTAL_FALLBACK_ACCENT;
}

/** The letter shown in place of a missing logo. */
export function businessInitial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}
