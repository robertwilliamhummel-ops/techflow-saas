"use client";

// Portal quote page (S-08): one quote in the branding of the business that sent
// it. Customers can't accept or decline in the portal yet, so an open quote
// points them back to the business.

import { useState, type ReactNode } from "react";

import {
  DocumentFacts,
  DocumentHeader,
  DocumentLoadFailed,
  DocumentNotes,
  DocumentNotFound,
  DocumentPanel,
  DocumentSheet,
  DocumentSkeleton,
  DocumentTotals,
  LineItems,
  PdfDownload,
  PortalDocumentFrame,
  usePortalDocument,
} from "@/components/portal/PortalDocument";
import { QuoteStatusBadge } from "@/components/quotes/QuoteStatusBadge";
import { dollarsToCents, formatIsoDate, formatMoneyCents } from "@/lib/format";
import { localIsoDate } from "@/lib/invoices/dueStatus";
import { getQuoteStatusBadgeProps } from "@/lib/invoices/statusBadge";
import {
  portalPdfHref,
  portalQuoteStatus,
  type CustomerQuoteView,
} from "@/lib/portal/portalDocument";
import type { QuoteStatus } from "@/lib/schema/tenant";

export function PortalQuote({
  quoteId,
  tenantId,
}: {
  quoteId: string;
  tenantId: string | null;
}) {
  const load = usePortalDocument<CustomerQuoteView>(
    "getCustomerQuoteDetail",
    "quoteId",
    quoteId,
    tenantId,
  );
  const [today] = useState(() => localIsoDate(new Date()));

  let body: ReactNode;
  if (load.state === "loading") {
    body = <DocumentSkeleton />;
  } else if (load.state === "failed") {
    body = <DocumentLoadFailed kind="quote" onRetry={load.retry} />;
  } else {
    const status = load.state === "ready" ? portalQuoteStatus(load.view, today) : null;
    body =
      load.state === "ready" && status ? (
        <QuoteSheet quote={load.view} status={status} today={today} />
      ) : (
        <DocumentNotFound kind="quote" />
      );
  }

  return <PortalDocumentFrame>{body}</PortalDocumentFrame>;
}

function QuoteSheet({
  quote,
  status,
  today,
}: {
  quote: CustomerQuoteView;
  status: QuoteStatus;
  today: string;
}) {
  const business = quote.tenantSnapshot;
  const currency = business.currency;

  return (
    <DocumentSheet label={`Quote ${quote.id} from ${business.name}`}>
      <DocumentHeader
        business={business}
        kind="Quote"
        id={quote.id}
        badge={<QuoteStatusBadge status={status} />}
      />

      <QuoteStanding quote={quote} status={status} today={today} />

      <DocumentFacts
        items={[
          {
            label: "Prepared for",
            value: (
              <>
                {quote.customer.name}
                <span className="block text-muted-foreground">{quote.customer.email}</span>
              </>
            ),
          },
          { label: "Issued", value: formatIsoDate(quote.issueDate) },
          { label: "Valid until", value: formatIsoDate(quote.validUntil) },
        ]}
      />

      <LineItems lines={quote.lineItems} currency={currency} />
      <DocumentTotals totals={quote.totals} currency={currency} />
      <DocumentNotes notes={quote.notes} />

      <div className="border-t pt-6">
        <PdfDownload
          href={portalPdfHref("quote", quote.tenantId, quote.id)}
          filename={`${quote.id}.pdf`}
        />
      </div>
    </DocumentSheet>
  );
}

function QuoteStanding({
  quote,
  status,
  today,
}: {
  quote: CustomerQuoteView;
  status: QuoteStatus;
  today: string;
}) {
  const business = quote.tenantSnapshot;
  const name = business.name || "the business";

  if (status === "sent") {
    return (
      <DocumentPanel labelledBy="portal-quote-total">
        <h2 id="portal-quote-total" className="text-sm text-muted-foreground">
          Quote total
        </h2>
        <p className="text-3xl font-semibold tracking-tight tabular-nums">
          {formatMoneyCents(dollarsToCents(quote.totals.total), business.currency)}
        </p>
        <p className="text-sm">
          {quote.validUntil === today
            ? "Valid until today"
            : `Valid until ${formatIsoDate(quote.validUntil)}`}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          To go ahead or ask about this quote, reply to the email {name} sent you.
        </p>
      </DocumentPanel>
    );
  }

  const detail: Partial<Record<QuoteStatus, string>> = {
    expired: `This quote expired on ${formatIsoDate(quote.validUntil)}. Ask ${name} for an updated quote.`,
    accepted: "This quote was accepted.",
    declined: "This quote was declined.",
    converted: `${business.name || "The business"} has turned this quote into an invoice. It will appear with your invoices once it's sent.`,
  };

  return (
    <DocumentPanel labelledBy="portal-quote-standing">
      <h2 id="portal-quote-standing" className="text-sm font-semibold">
        {getQuoteStatusBadgeProps(status).label}
      </h2>
      <p className="text-sm text-muted-foreground">{detail[status] ?? ""}</p>
    </DocumentPanel>
  );
}
