"use client";

// Building blocks shared by the portal invoice and quote pages (S-08): loading
// the customer's view of one document, and laying it out like the paper copy,
// in the branding of the business that sent it.

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { httpsCallable } from "firebase/functions";
import { ArrowLeft, Download, ExternalLink, FileDown } from "lucide-react";
import * as Sentry from "@sentry/nextjs";

import { BusinessMark } from "@/components/portal/BusinessMark";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getClientAuth, getClientFunctions } from "@/lib/firebase/client";
import { dollarsToCents, formatMoneyCents } from "@/lib/format";
import {
  formatTaxRate,
  isDocId,
  portalLoadError,
  type CustomerBusinessView,
  type CustomerLineItemView,
  type CustomerTotalsView,
} from "@/lib/portal/portalDocument";
import { cn } from "@/lib/utils";

export type PortalDocumentLoad<T> =
  | { state: "loading" }
  | { state: "not-found" }
  | { state: "failed"; retry: () => void }
  | { state: "ready"; view: T };

interface Loaded<T> {
  key: string;
  view: T | null;
  failed: boolean;
}

/**
 * Loads one document through its detail callable. An id or tenantId that can't
 * be a document id is not found without a request.
 */
export function usePortalDocument<T>(
  callable: "getCustomerInvoiceDetail" | "getCustomerQuoteDetail",
  idField: "invoiceId" | "quoteId",
  id: string,
  tenantId: string | null,
): PortalDocumentLoad<T> {
  const valid = isDocId(id) && isDocId(tenantId);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  // Results are tagged with the request they answer, so a late reply for
  // another document or an earlier attempt never shows.
  const key = `${callable}:${tenantId}:${id}:${attempt}`;

  useEffect(() => {
    if (!valid || !tenantId) return;
    let active = true;
    Promise.resolve()
      .then(() =>
        httpsCallable<Record<string, string>, T>(getClientFunctions(), callable)({
          tenantId,
          [idField]: id,
        }),
      )
      .then(({ data }) => {
        if (active) setLoaded({ key, view: data, failed: false });
      })
      .catch((err: unknown) => {
        const failed = portalLoadError(err) === "failed";
        if (failed) Sentry.captureException(err);
        if (active) setLoaded({ key, view: null, failed });
      });
    return () => {
      active = false;
    };
  }, [valid, callable, idField, id, tenantId, key]);

  if (!valid) return { state: "not-found" };
  if (!loaded || loaded.key !== key) return { state: "loading" };
  if (loaded.failed) return { state: "failed", retry: () => setAttempt((n) => n + 1) };
  if (!loaded.view) return { state: "not-found" };
  return { state: "ready", view: loaded.view };
}

export function PortalDocumentFrame({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto grid w-full max-w-3xl gap-4 px-4 py-6 sm:py-10">
      <Link
        href="/portal"
        className="flex w-fit items-center gap-1.5 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ArrowLeft aria-hidden className="size-4" />
        All invoices and quotes
      </Link>
      {children}
    </main>
  );
}

export function DocumentSheet({ label, children }: { label: string; children: ReactNode }) {
  return (
    <article
      aria-label={label}
      className="grid gap-8 rounded-xl bg-card p-5 ring-1 ring-foreground/10 sm:p-8"
    >
      {children}
    </article>
  );
}

export function DocumentHeader({
  business,
  kind,
  id,
  badge,
}: {
  business: CustomerBusinessView;
  kind: "Invoice" | "Quote";
  id: string;
  badge: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 items-start gap-3">
        <BusinessMark
          name={business.name}
          logoUrl={business.logoUrl}
          primaryColor={business.primaryColor}
        />
        <div className="grid min-w-0 gap-0.5">
          <p className="font-semibold wrap-break-word">{business.name || "Business"}</p>
          {business.address ? (
            <p className="text-sm whitespace-pre-line text-muted-foreground">{business.address}</p>
          ) : null}
          {business.businessNumber ? (
            <p className="text-xs text-muted-foreground">
              Business number {business.businessNumber}
            </p>
          ) : null}
        </div>
      </div>
      <div className="grid gap-1 sm:justify-items-end">
        <p aria-hidden className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {kind}
        </p>
        <h1 className="font-mono text-xl font-semibold">
          <span className="sr-only">{kind} </span>
          {id}
        </h1>
        <div>{badge}</div>
      </div>
    </header>
  );
}

/** A tinted band under the header for the one thing the customer came for. */
export function DocumentPanel({
  labelledBy,
  children,
  className,
}: {
  labelledBy: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={cn("grid gap-1 rounded-lg bg-muted/60 p-4 sm:p-5", className)}
    >
      {children}
    </section>
  );
}

export function DocumentFacts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="grid content-start gap-0.5 text-sm">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="wrap-break-word">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function LineItems({
  lines,
  currency,
}: {
  lines: CustomerLineItemView[];
  currency: string;
}) {
  const money = (dollars: number) => formatMoneyCents(dollarsToCents(dollars), currency);
  const mixedTax = lines.some((line) => line.taxable) && lines.some((line) => !line.taxable);

  return (
    <section aria-labelledby="portal-items" className="grid gap-2">
      <h2 id="portal-items" className="text-sm font-semibold">
        Items
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Rate</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line, index) => (
            <TableRow key={index}>
              <TableCell className="whitespace-normal">
                {line.description}
                {mixedTax && !line.taxable ? (
                  <span className="block text-xs text-muted-foreground">Tax-exempt</span>
                ) : null}
                <span className="block text-xs text-muted-foreground tabular-nums sm:hidden">
                  {money(line.rate)} each
                </span>
              </TableCell>
              <TableCell className="text-right align-top tabular-nums">{line.quantity}</TableCell>
              <TableCell className="hidden text-right align-top tabular-nums sm:table-cell">
                {money(line.rate)}
              </TableCell>
              <TableCell className="text-right align-top tabular-nums">{money(line.amount)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

export function TotalsRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className={cn("flex justify-between gap-4", strong && "font-semibold")}>
      <dt className={strong ? undefined : "text-muted-foreground"}>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function DocumentTotals({
  totals,
  currency,
  children,
}: {
  totals: CustomerTotalsView;
  currency: string;
  children?: ReactNode;
}) {
  const money = (dollars: number) => formatMoneyCents(dollarsToCents(dollars), currency);
  return (
    <dl className="ml-auto grid w-full max-w-xs gap-2 text-sm tabular-nums">
      <TotalsRow label="Subtotal" value={money(totals.subtotal)} />
      {totals.taxes.length > 0
        ? totals.taxes.map((tax, index) => (
            <TotalsRow
              key={index}
              label={`${tax.name} (${formatTaxRate(tax.rate)})${
                tax.taxableAmount !== totals.subtotal ? ` on ${money(tax.taxableAmount)}` : ""
              }`}
              value={money(tax.amount)}
            />
          ))
        : totals.taxAmount > 0
          ? <TotalsRow label="Tax" value={money(totals.taxAmount)} />
          : null}
      <div className="flex items-baseline justify-between gap-4 border-t pt-2">
        <dt className="font-medium">Total</dt>
        <dd className="text-base font-semibold">{money(totals.total)}</dd>
      </div>
      {children}
    </dl>
  );
}

export function DocumentNotes({ notes }: { notes: string | null }) {
  if (!notes) return null;
  return (
    <section aria-labelledby="portal-notes" className="grid gap-1">
      <h2 id="portal-notes" className="text-sm font-semibold">
        Notes
      </h2>
      <p className="text-sm whitespace-pre-line text-muted-foreground">{notes}</p>
    </section>
  );
}

type PdfState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "failed" };

/**
 * Fetches the PDF with the customer's ID token, then offers it as links the
 * customer taps. Browsers — Safari especially — may ignore a download started
 * from script after an await, and iOS shows only the first page of a PDF in a
 * frame, so there is no automatic download and no embedded preview.
 */
export function PdfDownload({ href, filename }: { href: string; filename: string }) {
  const [pdf, setPdf] = useState<PdfState>({ status: "idle" });

  // Release the file's memory when it's replaced or the page closes.
  useEffect(() => {
    if (pdf.status !== "ready") return;
    const { url } = pdf;
    return () => URL.revokeObjectURL(url);
  }, [pdf]);

  async function prepare() {
    setPdf({ status: "loading" });
    try {
      const user = getClientAuth().currentUser;
      if (!user) throw new Error("Signed out before the PDF was requested.");
      const response = await fetch(href, {
        headers: { Authorization: `Bearer ${await user.getIdToken()}` },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`PDF request failed with status ${response.status}.`);
      const blob = await response.blob();
      setPdf({ status: "ready", url: URL.createObjectURL(blob) });
    } catch (err) {
      Sentry.captureException(err);
      setPdf({ status: "failed" });
    }
  }

  if (pdf.status === "ready") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <a href={pdf.url} download={filename} className={buttonVariants({ variant: "outline" })}>
          <Download aria-hidden data-icon="inline-start" />
          Download {filename}
        </a>
        <a
          href={pdf.url}
          target="_blank"
          rel="noopener"
          className={buttonVariants({ variant: "ghost" })}
        >
          <ExternalLink aria-hidden data-icon="inline-start" />
          Open PDF
        </a>
      </div>
    );
  }

  return (
    <div className="grid justify-items-start gap-2">
      <Button variant="outline" onClick={prepare} disabled={pdf.status === "loading"}>
        <FileDown aria-hidden data-icon="inline-start" />
        {pdf.status === "loading" ? "Preparing PDF…" : "Get PDF"}
      </Button>
      {pdf.status === "failed" ? (
        <p role="alert" className="text-sm text-destructive">
          The PDF couldn&apos;t be created. Try again in a moment.
        </p>
      ) : null}
    </div>
  );
}

export function DocumentSkeleton() {
  return (
    <div role="status" className="grid gap-4">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-44 w-full rounded-xl" />
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  );
}

export function DocumentNotFound({ kind }: { kind: "invoice" | "quote" }) {
  return (
    <section className="grid gap-2 rounded-xl bg-card p-6 ring-1 ring-foreground/10">
      <h1 className="text-lg font-semibold">We couldn&apos;t find this {kind}</h1>
      <p className="max-w-prose text-sm text-muted-foreground">
        The link may be incomplete, or the {kind} was sent to a different email address
        than the one you signed in with.
      </p>
      <Link href="/portal" className={cn(buttonVariants({ variant: "outline" }), "mt-2 w-fit")}>
        See your invoices and quotes
      </Link>
    </section>
  );
}

export function DocumentLoadFailed({
  kind,
  onRetry,
}: {
  kind: "invoice" | "quote";
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertTitle>This {kind} didn&apos;t load</AlertTitle>
      <AlertDescription>Check your connection, then try again.</AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </AlertAction>
    </Alert>
  );
}
