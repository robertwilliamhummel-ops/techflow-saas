"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { limit, orderBy, where } from "firebase/firestore";
import { Plus } from "lucide-react";
import * as Sentry from "@sentry/nextjs";

import {
  InvoiceTable,
  invoiceHref,
  type InvoiceWithId,
} from "@/components/invoices/InvoiceTable";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatIsoDate, formatMoneyCents } from "@/lib/format";
import {
  PAYABLE_INVOICE_STATUSES,
  balanceDueCents,
  daysPastDue,
  isPastDue,
  localIsoDate,
  summarizeReceivables,
  type ReceivablesSummary,
} from "@/lib/invoices/dueStatus";
import { invoiceFilterHref } from "@/lib/invoices/listFilters";
import type { CurrencyCode } from "@/lib/schema/tenant";
import { useTenantContext } from "@/lib/tenant/TenantContext";
import { useTenantCollection } from "@/lib/tenant/useTenantCollection";
import { cn } from "@/lib/utils";

const OUTSTANDING_LIMIT = 500;
const DRAFTS_LIMIT = 100;
const RECENT_LIMIT = 8;
const OVERDUE_SHOWN = 5;

// Both status queries use the invoices (status, createdAt desc) index, pinned
// by functions/test/shared/firestoreIndexes.test.ts. Module constants keep the
// constraint identities stable for useTenantCollection.
const OUTSTANDING_QUERY = [
  where("status", "in", [...PAYABLE_INVOICE_STATUSES]),
  orderBy("createdAt", "desc"),
  limit(OUTSTANDING_LIMIT),
];
const DRAFTS_QUERY = [
  where("status", "==", "draft"),
  orderBy("createdAt", "desc"),
  limit(DRAFTS_LIMIT),
];
const RECENT_QUERY = [orderBy("createdAt", "desc"), limit(RECENT_LIMIT)];

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export default function DashboardPage() {
  const { meta, hasFeature, loading } = useTenantContext();

  if (loading) {
    return (
      <PageFrame businessName={null} showNewInvoice={false}>
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </PageFrame>
    );
  }

  if (!hasFeature("invoices")) {
    return (
      <PageFrame businessName={meta?.name ?? null} showNewInvoice={false}>
        <Alert>
          <AlertTitle>Invoicing isn&apos;t included in your plan</AlertTitle>
          <AlertDescription>
            Contact TechFlow support to add invoicing to your account.
          </AlertDescription>
        </Alert>
      </PageFrame>
    );
  }

  return (
    <PageFrame businessName={meta?.name ?? null} showNewInvoice>
      <DashboardHome currency={meta?.currency ?? "CAD"} />
    </PageFrame>
  );
}

function PageFrame({
  businessName,
  showNewInvoice,
  children,
}: {
  businessName: string | null;
  showNewInvoice: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          {businessName ? (
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {businessName}
            </p>
          ) : null}
        </div>
        {showNewInvoice ? (
          <Link href="/invoices/new" className={buttonVariants({ size: "lg" })}>
            <Plus data-icon="inline-start" aria-hidden />
            New invoice
          </Link>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function DashboardHome({ currency }: { currency: CurrencyCode }) {
  // Fixed for the life of the page — reload to roll over at midnight.
  const [today] = useState(() => localIsoDate(new Date()));
  const outstanding = useTenantCollection<InvoiceWithId>("invoices", OUTSTANDING_QUERY);
  const drafts = useTenantCollection<InvoiceWithId>("invoices", DRAFTS_QUERY);
  const recent = useTenantCollection<InvoiceWithId>("invoices", RECENT_QUERY);

  const summaries = useMemo(
    () => summarizeReceivables(outstanding.data, today, currency),
    [outstanding.data, today, currency],
  );
  const overdue = useMemo(
    () =>
      outstanding.data
        .filter((invoice) => isPastDue(invoice, today))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    [outstanding.data, today],
  );

  const error = outstanding.error ?? drafts.error ?? recent.error;
  useEffect(() => {
    if (error) Sentry.captureException(error);
  }, [error]);

  const overdueCount = summaries.reduce((sum, s) => sum + s.overdueCount, 0);
  const outstandingCount = summaries.reduce((sum, s) => sum + s.outstandingCount, 0);
  const draftCount = drafts.data.length;

  return (
    <>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load your invoices</AlertTitle>
          <AlertDescription>
            Refresh the page to try again. If it keeps happening, contact
            TechFlow support.
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-label="Summary" className="grid gap-4 sm:grid-cols-3">
        <SummaryCard
          label="Outstanding"
          loading={outstanding.loading}
          amounts={summaries.map((s) => amountOf(s, "outstandingCents"))}
          detail={plural(outstandingCount, "unpaid invoice")}
        />
        <SummaryCard
          label="Overdue"
          loading={outstanding.loading}
          amounts={summaries.map((s) => amountOf(s, "overdueCents"))}
          detail={overdueCount > 0 ? plural(overdueCount, "invoice") + " past due" : "Nothing past due"}
          tone={overdueCount > 0 ? "destructive" : "default"}
        />
        <SummaryCard
          label="Drafts"
          loading={drafts.loading}
          amounts={[
            {
              key: "drafts",
              text: draftCount >= DRAFTS_LIMIT ? `${DRAFTS_LIMIT}+` : String(draftCount),
            },
          ]}
          detail="Not sent yet"
        />
      </section>
      {outstanding.data.length >= OUTSTANDING_LIMIT ? (
        <p className="-mt-3 text-xs text-muted-foreground">
          Totals cover your {OUTSTANDING_LIMIT} most recent unpaid invoices.
        </p>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Overdue</CardTitle>
            <CardDescription>Oldest due date first.</CardDescription>
          </CardHeader>
          <CardContent>
            {outstanding.loading ? (
              <RowsSkeleton rows={3} />
            ) : overdue.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing is overdue.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {overdue.slice(0, OVERDUE_SHOWN).map((invoice) => {
                  const days = daysPastDue(invoice.dueDate, today);
                  return (
                    <li key={invoice.id}>
                      <Link
                        href={invoiceHref(invoice.id)}
                        className="flex items-center justify-between gap-3 rounded-md py-2.5 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">
                            {invoice.customer.name}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {invoice.id} ·{" "}
                            {days > 0
                              ? `${plural(days, "day")} overdue`
                              : `Due ${formatIsoDate(invoice.dueDate)}`}
                          </span>
                        </span>
                        <span className="shrink-0 font-medium tabular-nums">
                          {formatMoneyCents(
                            balanceDueCents(invoice),
                            invoice.tenantSnapshot.currency,
                          )}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            {overdue.length > OVERDUE_SHOWN ? (
              <Link
                href={invoiceFilterHref("overdue")}
                className="mt-3 inline-block text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                See all {overdue.length} overdue invoices
              </Link>
            ) : null}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Recent invoices</CardTitle>
            <CardDescription>The last {RECENT_LIMIT} you created.</CardDescription>
            <CardAction>
              <Link
                href="/invoices"
                className={buttonVariants({ variant: "ghost", size: "sm" })}
              >
                View all
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent>
            {recent.loading ? (
              <RowsSkeleton rows={4} />
            ) : recent.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No invoices yet.{" "}
                <Link
                  href="/invoices/new"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Create your first invoice
                </Link>
                .
              </p>
            ) : (
              <InvoiceTable invoices={recent.data} today={today} />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

interface AmountLine {
  key: string;
  text: string;
  zero?: boolean;
}

function amountOf(
  summary: ReceivablesSummary,
  field: "outstandingCents" | "overdueCents",
): AmountLine {
  return {
    key: summary.currency,
    text: formatMoneyCents(summary[field], summary.currency),
    zero: summary[field] === 0,
  };
}

function SummaryCard({
  label,
  amounts,
  detail,
  loading,
  tone = "default",
}: {
  label: string;
  amounts: AmountLine[];
  detail: string;
  loading: boolean;
  tone?: "default" | "destructive";
}) {
  // The first line is the tenant's currency; other currencies follow smaller,
  // and only when something is owed in them.
  const [primary, ...others] = amounts;
  const extra = others.filter((line) => !line.zero);
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        {loading ? (
          <Skeleton className="h-8 w-32" />
        ) : (
          // A plain element: a small card's CardTitle size overrides text-2xl.
          <p
            className={cn(
              "text-2xl font-semibold tabular-nums",
              tone === "destructive" && "text-destructive",
            )}
          >
            {primary?.text}
          </p>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-xs text-muted-foreground">
        {loading ? null : (
          <>
            {extra.map((line) => (
              <span key={line.key} className="tabular-nums">
                + {line.text}
              </span>
            ))}
            <span>{detail}</span>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RowsSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}
