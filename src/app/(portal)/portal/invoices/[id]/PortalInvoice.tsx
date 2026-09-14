"use client";

// Portal invoice page (S-08): one invoice in the branding of the business that
// sent it, what is owed, and the way to pay it — the same pay page the invoice
// email links to.

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";

import { InvoiceStatusBadge } from "@/components/invoices/InvoiceStatusBadge";
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
  TotalsRow,
  usePortalDocument,
} from "@/components/portal/PortalDocument";
import { buttonVariants } from "@/components/ui/button";
import { computeForeground } from "@/lib/design/contrast";
import {
  dollarsToCents,
  formatDateMillis,
  formatIsoDate,
  formatMoneyCents,
} from "@/lib/format";
import { localIsoDate } from "@/lib/invoices/dueStatus";
import { paymentMethodLabel } from "@/lib/invoices/labels";
import {
  portalInvoiceState,
  portalPdfHref,
  type CustomerInvoiceView,
  type PortalInvoiceState,
} from "@/lib/portal/portalDocument";
import { portalAccent } from "@/lib/portal/portalHome";
import { cn } from "@/lib/utils";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function PortalInvoice({
  invoiceId,
  tenantId,
}: {
  invoiceId: string;
  tenantId: string | null;
}) {
  const load = usePortalDocument<CustomerInvoiceView>(
    "getCustomerInvoiceDetail",
    "invoiceId",
    invoiceId,
    tenantId,
  );
  // Fixed for the visit, like the dashboard's overdue and link-expiry checks.
  const [today] = useState(() => localIsoDate(new Date()));
  const [now] = useState(() => Date.now());

  let body: ReactNode;
  if (load.state === "loading") {
    body = <DocumentSkeleton />;
  } else if (load.state === "failed") {
    body = <DocumentLoadFailed kind="invoice" onRetry={load.retry} />;
  } else {
    const state = load.state === "ready" ? portalInvoiceState(load.view, today, now) : null;
    body =
      load.state === "ready" && state ? (
        <InvoiceSheet invoice={load.view} state={state} today={today} />
      ) : (
        <DocumentNotFound kind="invoice" />
      );
  }

  return <PortalDocumentFrame>{body}</PortalDocumentFrame>;
}

function InvoiceSheet({
  invoice,
  state,
  today,
}: {
  invoice: CustomerInvoiceView;
  state: PortalInvoiceState;
  today: string;
}) {
  const business = invoice.tenantSnapshot;
  const currency = business.currency;
  const totalCents = dollarsToCents(invoice.totals.total);

  return (
    <DocumentSheet label={`Invoice ${invoice.id} from ${business.name}`}>
      <DocumentHeader
        business={business}
        kind="Invoice"
        id={invoice.id}
        badge={<InvoiceStatusBadge status={state.status} />}
      />

      {state.payable ? (
        <AmountDue invoice={invoice} state={state} today={today} />
      ) : (
        <PaymentOutcome invoice={invoice} state={state} />
      )}

      <DocumentFacts
        items={[
          {
            label: "Billed to",
            value: (
              <>
                {invoice.customer.name}
                <span className="block text-muted-foreground">{invoice.customer.email}</span>
              </>
            ),
          },
          { label: "Issued", value: formatIsoDate(invoice.issueDate) },
          { label: "Due", value: formatIsoDate(invoice.dueDate) },
        ]}
      />

      <LineItems lines={invoice.lineItems} currency={currency} />

      <DocumentTotals totals={invoice.totals} currency={currency}>
        {invoice.surchargeAmountCents ? (
          <>
            <TotalsRow
              label="Card fee"
              value={formatMoneyCents(invoice.surchargeAmountCents, currency)}
            />
            <TotalsRow
              label="Total charged"
              value={formatMoneyCents(totalCents + invoice.surchargeAmountCents, currency)}
            />
          </>
        ) : null}
        {state.status === "partial" ? (
          <>
            <TotalsRow
              label="Paid"
              value={formatMoneyCents(invoice.paidAmountCents ?? 0, currency)}
            />
            <TotalsRow
              label="Balance due"
              value={formatMoneyCents(state.balanceCents, currency)}
              strong
            />
          </>
        ) : null}
      </DocumentTotals>

      <DocumentNotes notes={invoice.notes} />

      <div className="border-t pt-6">
        <PdfDownload
          href={portalPdfHref("invoice", invoice.tenantId, invoice.id)}
          filename={`${invoice.id}.pdf`}
        />
      </div>
    </DocumentSheet>
  );
}

function AmountDue({
  invoice,
  state,
  today,
}: {
  invoice: CustomerInvoiceView;
  state: PortalInvoiceState;
  today: string;
}) {
  const business = invoice.tenantSnapshot;
  const name = business.name || "the business";
  const amount = formatMoneyCents(state.balanceCents, business.currency);
  const accent = portalAccent(business.primaryColor);

  let due: ReactNode;
  if (state.daysOverdue > 0) {
    due = (
      <span className="font-medium text-destructive">
        Overdue by {plural(state.daysOverdue, "day")}
      </span>
    );
  } else if (state.status === "overdue") {
    due = <span className="font-medium text-destructive">Overdue</span>;
  } else if (invoice.dueDate === today) {
    due = "Due today";
  } else {
    due = `Due ${formatIsoDate(invoice.dueDate)}`;
  }

  return (
    <DocumentPanel
      labelledBy="portal-amount-due"
      className="gap-4 sm:grid-cols-[1fr_auto] sm:items-center"
    >
      <div className="grid gap-1">
        <h2 id="portal-amount-due" className="text-sm text-muted-foreground">
          Amount due
        </h2>
        <p className="text-3xl font-semibold tracking-tight tabular-nums">{amount}</p>
        <p className="text-sm">{due}</p>
      </div>
      {state.pay?.kind === "pay" ? (
        // No prefetch: the pay page checks the link on every render.
        <Link
          href={state.pay.href}
          prefetch={false}
          className={cn(
            buttonVariants({ size: "lg" }),
            "h-11 w-full px-6 text-base hover:opacity-90 sm:w-auto",
          )}
          style={{ backgroundColor: accent, color: computeForeground(accent) }}
        >
          Pay {amount}
        </Link>
      ) : (
        <p className="flex items-start gap-2 text-sm sm:max-w-64">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          {state.pay?.kind === "link-expired"
            ? `The payment link for this invoice has expired. Ask ${name} to send the invoice again.`
            : `To pay this invoice, contact ${name}.`}
        </p>
      )}
    </DocumentPanel>
  );
}

function PaymentOutcome({
  invoice,
  state,
}: {
  invoice: CustomerInvoiceView;
  state: PortalInvoiceState;
}) {
  const business = invoice.tenantSnapshot;
  const name = business.name || "The business";
  const currency = business.currency;
  const paidCents = invoice.paidAmountCents ?? dollarsToCents(invoice.totals.total);
  // A payment the business recorded by hand has no method worth naming.
  const method =
    invoice.paymentMethod === "manual" ? null : paymentMethodLabel(invoice.paymentMethod);

  let title: string;
  let detail: string;
  if (state.status === "paid") {
    const paidOn = formatDateMillis(invoice.paidAt);
    title = "Paid";
    detail = [
      `${formatMoneyCents(paidCents, currency)} paid${paidOn ? ` on ${paidOn}` : ""}`,
      method,
    ]
      .filter(Boolean)
      .join(" · ");
  } else if (state.status === "refunded" || state.status === "partially-refunded") {
    const refundedOn = formatDateMillis(invoice.refundedAt);
    const refunded =
      invoice.refundedAmountCents != null
        ? formatMoneyCents(invoice.refundedAmountCents, currency)
        : null;
    title = state.status === "refunded" ? "Refunded" : "Partly refunded";
    const what = refunded ?? (state.status === "refunded" ? "Your payment" : "Part of your payment");
    detail = `${what} was refunded${refundedOn ? ` on ${refundedOn}` : ""}.`;
  } else {
    const voidedOn = formatDateMillis(invoice.voidedAt);
    title = "Cancelled";
    detail = `${name} cancelled this invoice${voidedOn ? ` on ${voidedOn}` : ""}. Nothing is owed.`;
  }

  return (
    <DocumentPanel labelledBy="portal-payment-status">
      <h2 id="portal-payment-status" className="text-sm font-semibold">
        {title}
      </h2>
      <p className="text-sm text-muted-foreground">{detail}</p>
    </DocumentPanel>
  );
}
