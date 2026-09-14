// Quote statuses and actions for the dashboard (S-06). Nothing stores
// `expired` — no job flips it — so a sent quote past its validUntil shows as
// expired, the way dueStatus.ts derives overdue. The actions mirror the quote
// callables' checks: sendQuoteEmail and convertQuoteToInvoice refuse converted
// quotes, and deleteQuote also needs an owner or admin.

import { matchesSearch } from "@/lib/search";
import type { MembershipRole, Quote, QuoteStatus } from "@/lib/schema/tenant";

export function displayQuoteStatus(
  quote: Pick<Quote, "status" | "validUntil">,
  today: string,
): QuoteStatus {
  // YYYY-MM-DD strings sort in date order; a quote valid until today is still open.
  return quote.status === "sent" && quote.validUntil < today ? "expired" : quote.status;
}

export interface QuoteActions {
  send: boolean;
  resend: boolean;
  previewPdf: boolean;
  convert: boolean;
  deleteQuote: boolean;
}

export function quoteActionsFor(
  status: QuoteStatus,
  role: MembershipRole | undefined,
  canInvoice: boolean,
): QuoteActions {
  const converted = status === "converted";
  const manager = role === "owner" || role === "admin";
  return {
    send: status === "draft",
    resend: !converted && status !== "draft",
    previewPdf: true,
    convert: !converted && canInvoice,
    deleteQuote: manager && !converted,
  };
}

export type QuoteFilterKey = "all" | "draft" | "sent" | "converted";

export interface QuoteListFilter {
  key: QuoteFilterKey;
  label: string;
  /** Statuses to query; null queries every quote. */
  statuses: readonly QuoteStatus[] | null;
}

export const QUOTE_LIST_FILTERS: readonly QuoteListFilter[] = [
  { key: "all", label: "All", statuses: null },
  { key: "draft", label: "Drafts", statuses: ["draft"] },
  { key: "sent", label: "Sent", statuses: ["sent"] },
  { key: "converted", label: "Converted", statuses: ["converted"] },
];

export function quoteFilterFor(raw: string | null | undefined): QuoteListFilter {
  return QUOTE_LIST_FILTERS.find((filter) => filter.key === raw) ?? QUOTE_LIST_FILTERS[0];
}

export function quoteFilterHref(key: QuoteFilterKey): string {
  return key === "all" ? "/quotes" : `/quotes?status=${key}`;
}

export function matchesQuoteSearch(
  quote: Pick<Quote, "customer"> & { id: string },
  query: string,
): boolean {
  return matchesSearch([quote.id, quote.customer.name, quote.customer.email], query);
}

export function quoteHref(id: string): string {
  return `/quotes/${encodeURIComponent(id)}`;
}
