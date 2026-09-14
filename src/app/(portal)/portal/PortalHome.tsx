"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight, CircleCheck, FileText } from "lucide-react";

import { InvoiceStatusBadge } from "@/components/invoices/InvoiceStatusBadge";
import { BusinessMark } from "@/components/portal/BusinessMark";
import { QuoteStatusBadge } from "@/components/quotes/QuoteStatusBadge";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { dollarsToCents, formatIsoDate, formatMoneyCents } from "@/lib/format";
import { localIsoDate } from "@/lib/invoices/dueStatus";
import type { CustomerInvoiceListItem } from "@/lib/portal/CustomerPortalContext";
import {
  buildPortalHome,
  portalInvoiceHref,
  portalQuoteHref,
  type PortalBalance,
  type PortalInvoiceRow,
  type PortalQuoteRow,
} from "@/lib/portal/portalHome";
import { useCustomerPortal } from "@/lib/portal/useCustomerPortal";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function PortalHome() {
  const { customerEmail, invoices, quotes, loading, error, reload } = useCustomerPortal();
  const [retrying, setRetrying] = useState(false);
  // The viewer's calendar date, the same basis the dashboard uses for overdue.
  const today = localIsoDate(new Date());
  const home = useMemo(
    () => buildPortalHome(invoices, quotes, today),
    [invoices, quotes, today],
  );

  async function retry() {
    setRetrying(true);
    try {
      await reload();
    } finally {
      setRetrying(false);
    }
  }

  const nothingYet = !error && invoices.length === 0 && quotes.length === 0;

  return (
    <main className="mx-auto grid w-full max-w-3xl gap-8 px-4 py-8 sm:py-10">
      <header className="grid gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          Your invoices and quotes
        </h1>
        {customerEmail ? (
          <p className="text-sm text-muted-foreground">
            Everything businesses have sent to{" "}
            <span className="font-medium wrap-break-word text-foreground">{customerEmail}</span>.
          </p>
        ) : null}
      </header>

      {loading ? (
        <HomeSkeleton />
      ) : (
        <>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Some of your documents didn&apos;t load</AlertTitle>
              <AlertDescription>Check your connection, then try again.</AlertDescription>
              <AlertAction>
                <Button size="sm" variant="outline" onClick={retry} disabled={retrying}>
                  Try again
                </Button>
              </AlertAction>
            </Alert>
          ) : null}

          {nothingYet ? (
            <EmptyState />
          ) : (
            <>
              <BalanceSummary balances={home.balances} hasInvoices={invoices.length > 0} />

              {home.toPay.length > 0 ? (
                <DocumentSection id="portal-to-pay" title="To pay">
                  {home.toPay.map((row) => (
                    <InvoiceRow key={row.invoice.path} row={row} today={today} />
                  ))}
                </DocumentSection>
              ) : null}

              {home.openQuotes.length > 0 ? (
                <DocumentSection id="portal-open-quotes" title="Open quotes">
                  {home.openQuotes.map((row) => (
                    <QuoteRow key={row.quote.path} row={row} today={today} />
                  ))}
                </DocumentSection>
              ) : null}

              {home.pastInvoices.length > 0 ? (
                <DocumentSection id="portal-past-invoices" title="Past invoices">
                  {home.pastInvoices.map((row) => (
                    <InvoiceRow key={row.invoice.path} row={row} today={today} />
                  ))}
                </DocumentSection>
              ) : null}

              {home.pastQuotes.length > 0 ? (
                <DocumentSection id="portal-past-quotes" title="Past quotes">
                  {home.pastQuotes.map((row) => (
                    <QuoteRow key={row.quote.path} row={row} today={today} />
                  ))}
                </DocumentSection>
              ) : null}
            </>
          )}
        </>
      )}
    </main>
  );
}

function BalanceSummary({
  balances,
  hasInvoices,
}: {
  balances: PortalBalance[];
  hasInvoices: boolean;
}) {
  if (balances.length === 0) {
    if (!hasInvoices) return null;
    return (
      <div className="flex items-center gap-3 rounded-xl bg-card px-4 py-3 text-sm ring-1 ring-foreground/10">
        <CircleCheck aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <p>You&apos;re all paid up — nothing is due right now.</p>
      </div>
    );
  }

  return (
    <section
      aria-labelledby="portal-balance"
      className="grid gap-3 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
    >
      <h2 id="portal-balance" className="text-sm font-medium text-muted-foreground">
        Total to pay
      </h2>
      <div className="flex flex-wrap gap-x-10 gap-y-4">
        {balances.map((balance) => (
          <div key={balance.currency} className="grid gap-1">
            <p className="text-3xl font-semibold tracking-tight tabular-nums">
              {formatMoneyCents(balance.owedCents, balance.currency)}
            </p>
            <p className="text-sm text-muted-foreground">
              {plural(balance.count, "invoice")}
              {balance.overdueCount > 0 ? (
                <>
                  {" · "}
                  <span className="font-medium text-destructive">
                    {formatMoneyCents(balance.overdueCents, balance.currency)} overdue
                  </span>
                </>
              ) : null}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function DocumentSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        {children}
      </ul>
    </section>
  );
}

function DocumentRow({
  href,
  branding,
  label,
  details,
  amount,
  badge,
}: {
  href: string;
  branding: CustomerInvoiceListItem["tenantBranding"];
  label: string;
  details: ReactNode[];
  amount: string;
  badge: ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <BusinessMark
          name={branding.name}
          logoUrl={branding.logoUrl}
          primaryColor={branding.primaryColor}
        />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="truncate text-sm font-medium">{branding.name || "Business"}</p>
          {/* Phones stack each detail on its own line; wider screens run them
              inline, separated by dots, so no line starts with a separator. */}
          <p className="flex flex-wrap gap-x-1.5 text-sm text-muted-foreground">
            <span className="font-mono text-xs leading-5">{label}</span>
            {details.map((detail, index) => (
              <span key={index} className="flex basis-full gap-x-1.5 sm:basis-auto">
                <span aria-hidden className="hidden sm:inline">
                  ·
                </span>
                {detail}
              </span>
            ))}
          </p>
        </div>
        <div className="grid shrink-0 justify-items-end gap-1">
          <p className="text-sm font-semibold tabular-nums">{amount}</p>
          {badge}
        </div>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

function InvoiceRow({ row, today }: { row: PortalInvoiceRow; today: string }) {
  const { invoice, status, balanceCents, daysOverdue } = row;
  const totalCents = dollarsToCents(invoice.totals.total);
  const payable = row.balanceCents > 0 || status === "overdue";
  const details: ReactNode[] = [];

  if (!payable) {
    details.push(`Issued ${formatIsoDate(invoice.issueDate)}`);
  } else if (daysOverdue > 0) {
    details.push(
      <span className="font-medium text-destructive">
        Overdue by {plural(daysOverdue, "day")}
      </span>,
    );
  } else if (status === "overdue") {
    details.push(<span className="font-medium text-destructive">Overdue</span>);
  } else if (invoice.dueDate === today) {
    details.push("Due today");
  } else {
    details.push(`Due ${formatIsoDate(invoice.dueDate)}`);
  }

  if (invoice.status === "partial" && invoice.paidAmountCents) {
    details.push(
      `Paid ${formatMoneyCents(invoice.paidAmountCents, invoice.currency)} of ${formatMoneyCents(totalCents, invoice.currency)}`,
    );
  }

  return (
    <DocumentRow
      href={portalInvoiceHref(invoice)}
      branding={invoice.tenantBranding}
      label={invoice.id}
      details={details}
      amount={formatMoneyCents(payable ? balanceCents : totalCents, invoice.currency)}
      badge={<InvoiceStatusBadge status={status} />}
    />
  );
}

function QuoteRow({ row, today }: { row: PortalQuoteRow; today: string }) {
  const { quote, status } = row;
  const detail =
    status !== "sent"
      ? `Issued ${formatIsoDate(quote.issueDate)}`
      : quote.validUntil === today
        ? "Valid until today"
        : `Valid until ${formatIsoDate(quote.validUntil)}`;

  return (
    <DocumentRow
      href={portalQuoteHref(quote)}
      branding={quote.tenantBranding}
      label={quote.id}
      details={[detail]}
      amount={formatMoneyCents(dollarsToCents(quote.totals.total), quote.currency)}
      badge={<QuoteStatusBadge status={status} />}
    />
  );
}

function EmptyState() {
  return (
    <div className="grid justify-items-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center">
      <FileText aria-hidden className="size-8 text-muted-foreground" />
      <h2 className="text-base font-semibold">Nothing here yet</h2>
      <p className="max-w-sm text-sm text-balance text-muted-foreground">
        When a business sends an invoice or quote to this address, you&apos;ll find it here.
      </p>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div role="status" className="grid gap-8">
      <span className="sr-only">Loading your documents…</span>
      <Skeleton className="h-28 w-full rounded-xl" />
      <div className="grid gap-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-44 w-full rounded-xl" />
      </div>
    </div>
  );
}
