"use client";

// Quote detail (S-06). Reads the quote live; every change goes through a
// callable, and the actions offered mirror their checks
// (src/lib/quotes/quoteStatus.ts).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { toast } from "sonner";
import * as Sentry from "@sentry/nextjs";

import { TextField } from "@/components/forms/fields";
import { invoiceHref } from "@/components/invoices/InvoiceTable";
import { QuoteStatusBadge } from "@/components/quotes/QuoteStatusBadge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth/useAuth";
import { getClientFunctions } from "@/lib/firebase/client";
import {
  dollarsToCents,
  formatIsoDate,
  formatMoneyCents,
  formatTimestamp,
} from "@/lib/format";
import { localIsoDate } from "@/lib/invoices/dueStatus";
import { addDaysIso, isIsoCalendarDate } from "@/lib/isoDate";
import { displayQuoteStatus, quoteActionsFor } from "@/lib/quotes/quoteStatus";
import type { Quote, TenantMeta } from "@/lib/schema/tenant";
import { useTenantContext } from "@/lib/tenant/TenantContext";
import { useTenantDoc } from "@/lib/tenant/useTenantDoc";

type QuoteWithId = Quote & { id: string };

// requireDocId in Cloud Functions; anything else can't be a quote id.
const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;
// The same terms convertQuoteToInvoice and the new-invoice form default to.
const DEFAULT_TERMS_DAYS = 30;

function errorMessage(err: unknown, fallback: string): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /(internal|unknown)$/.test(code)) return fallback;
  return err instanceof Error && err.message ? err.message : fallback;
}

function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

export function QuoteDetail({ quoteId }: { quoteId: string }) {
  const { meta, hasFeature, loading } = useTenantContext();

  let body: React.ReactNode;
  if (!DOC_ID.test(quoteId) || /^__.*__$/.test(quoteId)) {
    body = <NotFound />;
  } else if (loading) {
    body = <Skeleton className="h-[32rem] rounded-xl" />;
  } else if (!hasFeature("quotes")) {
    body = (
      <Alert>
        <AlertTitle>Quotes aren&apos;t included in your plan</AlertTitle>
        <AlertDescription>
          Contact TechFlow support to add quotes to your account.
        </AlertDescription>
      </Alert>
    );
  } else {
    body = <QuoteDetailBody quoteId={quoteId} meta={meta} canInvoice={hasFeature("invoices")} />;
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-8">
      <Link
        href="/quotes"
        className="w-fit text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Quotes
      </Link>
      {body}
    </div>
  );
}

function NotFound() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quote not found</CardTitle>
        <CardDescription>It may have been deleted, or the link is wrong.</CardDescription>
      </CardHeader>
      <CardContent>
        <Link href="/quotes" className={buttonVariants({ variant: "outline" })}>
          Back to quotes
        </Link>
      </CardContent>
    </Card>
  );
}

function QuoteDetailBody({
  quoteId,
  canInvoice,
}: {
  quoteId: string;
  meta: TenantMeta | null;
  canInvoice: boolean;
}) {
  const router = useRouter();
  const { claims } = useAuth();
  const { data: quote, loading, error } = useTenantDoc<QuoteWithId>(`quotes/${quoteId}`);
  const [today] = useState(() => localIsoDate(new Date()));
  const [busy, setBusy] = useState<string | null>(null);
  const [pdf, setPdf] = useState<{ url: string; filename: string } | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const [issueDate, setIssueDate] = useState(today);
  const [dueDate, setDueDate] = useState(() => addDaysIso(today, DEFAULT_TERMS_DAYS));
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (error) Sentry.captureException(error);
  }, [error]);

  // Release the previous preview's memory when it's replaced or the page closes.
  useEffect(() => {
    if (!pdf) return;
    return () => URL.revokeObjectURL(pdf.url);
  }, [pdf]);

  if (loading) return <Skeleton className="h-[32rem] rounded-xl" />;
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load this quote</AlertTitle>
        <AlertDescription>Refresh the page to try again.</AlertDescription>
      </Alert>
    );
  }
  if (!quote) return <NotFound />;

  const status = displayQuoteStatus(quote, today);
  const actions = quoteActionsFor(quote.status, claims.role, canInvoice);
  const currency = quote.tenantSnapshot.currency;
  const money = (dollars: number) => formatMoneyCents(dollarsToCents(dollars), currency);
  const mixedTax =
    quote.lineItems.some((line) => line.taxable) && quote.lineItems.some((line) => !line.taxable);

  const issueError = isIsoCalendarDate(issueDate) ? null : "Enter a valid date.";
  const dueError = !isIsoCalendarDate(dueDate)
    ? "Enter a valid date."
    : !issueError && dueDate < issueDate
      ? "The due date can't be before the issue date."
      : null;

  async function run<T>(key: string, name: string, data: Record<string, unknown>, fallback: string): Promise<T | null> {
    setBusy(key);
    try {
      const { data: result } = await httpsCallable<Record<string, unknown>, T>(getClientFunctions(), name)(data);
      return result;
    } catch (err) {
      Sentry.captureException(err);
      toast.error(errorMessage(err, fallback));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    const result = await run("send", "sendQuoteEmail", { quoteId }, "Couldn't send the quote. Try again.");
    if (result) toast.success(`Quote ${quoteId} sent to ${quote!.customer.email}.`);
  }

  async function previewPdf() {
    const result = await run<{ pdfBase64: string; contentType: string; filename: string }>(
      "pdf",
      "previewQuotePDF",
      { quoteId },
      "Couldn't create the PDF. Try again.",
    );
    if (result) {
      const blob = base64ToBlob(result.pdfBase64, result.contentType || "application/pdf");
      setPdf({ url: URL.createObjectURL(blob), filename: result.filename });
    }
  }

  async function convert() {
    if (issueError || dueError) return;
    const result = await run<{ invoiceId: string }>(
      "convert",
      "convertQuoteToInvoice",
      { quoteId, issueDate, dueDate },
      "Couldn't create the invoice. Try again.",
    );
    if (result) {
      setConvertOpen(false);
      toast.success(`Invoice ${result.invoiceId} created as a draft from ${quoteId}.`);
      router.push(invoiceHref(result.invoiceId));
    }
  }

  async function deleteQuote() {
    const result = await run("delete", "deleteQuote", { quoteId }, "Couldn't delete the quote. Try again.");
    if (result) {
      setDeleteOpen(false);
      toast.success(`Quote ${quoteId} deleted.`);
      router.replace("/quotes");
    }
  }

  const activity: { label: string; value: string }[] = [];
  const created = formatTimestamp(quote.createdAt);
  if (created) activity.push({ label: "Created", value: created });
  const sent = formatTimestamp(quote.sentAt);
  if (sent) activity.push({ label: "Sent", value: sent });
  const updated = formatTimestamp(quote.updatedAt);
  if (updated) activity.push({ label: quote.status === "converted" ? "Converted" : "Updated", value: updated });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">{quote.id}</h1>
            <QuoteStatusBadge status={status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {quote.customer.name} · {money(quote.totals.total)} ·{" "}
            {status === "expired" ? "Expired" : "Valid until"} {formatIsoDate(quote.validUntil)}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {actions.convert ? (
            <Button onClick={() => setConvertOpen(true)} disabled={busy !== null}>
              Convert to invoice
            </Button>
          ) : null}
          {actions.send || actions.resend ? (
            <Button variant="outline" onClick={send} disabled={busy !== null}>
              {busy === "send" ? "Sending…" : actions.send ? "Send quote" : "Resend"}
            </Button>
          ) : null}
          <Button variant="outline" onClick={previewPdf} disabled={busy !== null}>
            {busy === "pdf" ? "Creating PDF…" : "Preview PDF"}
          </Button>
          {actions.deleteQuote ? (
            <Button variant="destructive" onClick={() => setDeleteOpen(true)} disabled={busy !== null}>
              Delete
            </Button>
          ) : null}
        </div>
      </div>

      {quote.status === "converted" && quote.convertedToInvoiceId ? (
        <Alert>
          <AlertTitle>Converted to an invoice</AlertTitle>
          <AlertDescription>
            This quote became{" "}
            <Link href={invoiceHref(quote.convertedToInvoiceId)} className="font-medium underline underline-offset-4">
              invoice {quote.convertedToInvoiceId}
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : null}

      {pdf ? (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>{pdf.filename}</CardTitle>
            <div className="flex gap-2">
              <a href={pdf.url} download={pdf.filename} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Download
              </a>
              <a href={pdf.url} target="_blank" rel="noopener" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Open
              </a>
              <Button variant="ghost" size="sm" onClick={() => setPdf(null)}>
                Close
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <iframe title={`${quote.id} PDF preview`} src={pdf.url} className="h-[70vh] w-full rounded-md border bg-white" />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card>
            <CardContent className="grid gap-6 sm:grid-cols-2">
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-xs font-medium text-muted-foreground">Prepared for</span>
                <span className="font-medium">{quote.customer.name}</span>
                <span className="break-all">{quote.customer.email}</span>
                {quote.customer.phone ? <span>{quote.customer.phone}</span> : null}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Issued</dt>
                <dd>{formatIsoDate(quote.issueDate)}</dd>
                <dt className="text-muted-foreground">Valid until</dt>
                <dd>{formatIsoDate(quote.validUntil)}</dd>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Items</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
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
                  {quote.lineItems.map((line, index) => (
                    <TableRow key={index}>
                      <TableCell className="whitespace-normal">
                        {line.description}
                        {mixedTax && !line.taxable ? (
                          <span className="ml-2 text-xs text-muted-foreground">Tax-exempt</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{line.quantity}</TableCell>
                      <TableCell className="hidden text-right tabular-nums sm:table-cell">{money(line.rate)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(line.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <dl className="ml-auto flex w-full max-w-xs flex-col gap-2 text-sm tabular-nums">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Subtotal</dt>
                  <dd>{money(quote.totals.subtotal)}</dd>
                </div>
                {quote.totals.taxes.map((tax) => (
                  <div key={tax.name} className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">
                      {tax.name} ({Math.round(tax.rate * 10000) / 100}%)
                      {tax.taxableAmount !== quote.totals.subtotal ? ` on ${money(tax.taxableAmount)}` : ""}
                    </dt>
                    <dd>{money(tax.amount)}</dd>
                  </div>
                ))}
                <div className="flex items-baseline justify-between gap-4 border-t pt-2">
                  <dt className="font-medium">Total</dt>
                  <dd className="text-base font-semibold">{money(quote.totals.total)}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          {quote.notes ? (
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
                <CardDescription>Shown to your customer on the quote.</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-line">{quote.notes}</p>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-3 text-sm">
              {activity.map((item) => (
                <li key={item.label} className="flex flex-col">
                  <span className="font-medium">{item.label}</span>
                  <span className="text-muted-foreground">{item.value}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>

      <Dialog open={convertOpen} onOpenChange={setConvertOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convert {quote.id} to an invoice</DialogTitle>
            <DialogDescription>
              The invoice starts as a draft with this quote&apos;s customer and
              items, and today&apos;s tax and branding. The quote is marked
              converted.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              id="convert-issue-date"
              label="Issue date"
              error={issueError ?? undefined}
              inputProps={{ type: "date", value: issueDate, onChange: (event) => setIssueDate(event.target.value) }}
            />
            <TextField
              id="convert-due-date"
              label="Due date"
              error={dueError ?? undefined}
              inputProps={{ type: "date", value: dueDate, onChange: (event) => setDueDate(event.target.value) }}
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button onClick={convert} disabled={busy !== null || Boolean(issueError || dueError)}>
              {busy === "convert" ? "Creating invoice…" : "Create invoice"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete quote {quote.id}?</AlertDialogTitle>
            <AlertDialogDescription>
              {quote.status === "draft"
                ? "The draft was never sent. This can't be undone."
                : "Your customer may still have the emailed copy. This can't be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep quote</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={deleteQuote} disabled={busy !== null}>
              {busy === "delete" ? "Deleting…" : "Delete quote"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
