"use client";

// Invoice detail (S-04). Reads the invoice live from Firestore; every change
// goes through a callable, and the actions offered mirror the callables'
// status and role checks (src/lib/invoices/invoiceActions.ts).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { toast } from "sonner";
import * as Sentry from "@sentry/nextjs";

import { InvoiceStatusBadge } from "@/components/invoices/InvoiceStatusBadge";
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
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth/useAuth";
import { getClientFunctions } from "@/lib/firebase/client";
import {
  dollarsToCents,
  formatIsoDate,
  formatMoneyCents,
  formatTimestamp,
} from "@/lib/format";
import {
  balanceDueCents,
  daysPastDue,
  displayInvoiceStatus,
  isPastDue,
  localIsoDate,
} from "@/lib/invoices/dueStatus";
import { invoiceActionsFor, payLinkFor } from "@/lib/invoices/invoiceActions";
import {
  EMAIL_STATUS,
  MANUAL_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  paymentMethodLabel,
} from "@/lib/invoices/labels";
import type { Invoice, TenantMeta } from "@/lib/schema/tenant";
import { useTenantContext } from "@/lib/tenant/TenantContext";
import { useTenantDoc } from "@/lib/tenant/useTenantDoc";

type InvoiceWithId = Invoice & { id: string };
type ManualMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

// requireDocId in Cloud Functions; anything else can't be an invoice id.
const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;

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

export function InvoiceDetail({ invoiceId }: { invoiceId: string }) {
  const { meta, hasFeature, loading } = useTenantContext();

  let body: React.ReactNode;
  if (!DOC_ID.test(invoiceId) || /^__.*__$/.test(invoiceId)) {
    body = <NotFound />;
  } else if (loading) {
    body = <Skeleton className="h-[32rem] rounded-xl" />;
  } else if (!hasFeature("invoices")) {
    body = (
      <Alert>
        <AlertTitle>Invoicing isn&apos;t included in your plan</AlertTitle>
        <AlertDescription>
          Contact TechFlow support to add invoicing to your account.
        </AlertDescription>
      </Alert>
    );
  } else {
    body = <InvoiceDetailBody invoiceId={invoiceId} meta={meta} />;
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-8">
      <Link
        href="/invoices"
        className="w-fit text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Invoices
      </Link>
      {body}
    </div>
  );
}

function NotFound() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoice not found</CardTitle>
        <CardDescription>
          It may have been a draft that was deleted, or the link is wrong.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link href="/invoices" className={buttonVariants({ variant: "outline" })}>
          Back to invoices
        </Link>
      </CardContent>
    </Card>
  );
}

function InvoiceDetailBody({
  invoiceId,
  meta,
}: {
  invoiceId: string;
  meta: TenantMeta | null;
}) {
  const router = useRouter();
  const { claims } = useAuth();
  const { data: invoice, loading, error } = useTenantDoc<InvoiceWithId>(`invoices/${invoiceId}`);
  const [today] = useState(() => localIsoDate(new Date()));
  const [now] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [pdf, setPdf] = useState<{ url: string; filename: string } | null>(null);
  const [markPaidOpen, setMarkPaidOpen] = useState(false);
  const [method, setMethod] = useState<ManualMethod>("etransfer");
  const [sendReceipt, setSendReceipt] = useState(true);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reissueOpen, setReissueOpen] = useState(false);

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
        <AlertTitle>Couldn&apos;t load this invoice</AlertTitle>
        <AlertDescription>Refresh the page to try again.</AlertDescription>
      </Alert>
    );
  }
  if (!invoice) return <NotFound />;

  const status = displayInvoiceStatus(invoice, today);
  const actions = invoiceActionsFor(invoice.status, claims.role);
  const currency = invoice.tenantSnapshot.currency;
  const money = (dollars: number) => formatMoneyCents(dollarsToCents(dollars), currency);
  const canCollect =
    Boolean(meta?.etransferEmail) || meta?.stripeStatus?.chargesEnabled === true;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || window.location.origin;
  const payLink = invoice.payToken ? payLinkFor(invoice.payToken, appUrl) : null;
  const payLinkExpired = invoice.payTokenExpiresAt
    ? invoice.payTokenExpiresAt.toMillis() < now
    : false;
  const pastDueDays = isPastDue(invoice, today) ? daysPastDue(invoice.dueDate, today) : 0;
  const mixedTax =
    invoice.lineItems.some((line) => line.taxable) &&
    invoice.lineItems.some((line) => !line.taxable);

  async function run<T>(
    key: string,
    name: string,
    data: Record<string, unknown>,
    fallback: string,
  ): Promise<T | null> {
    setBusy(key);
    try {
      const { data: result } = await httpsCallable<Record<string, unknown>, T>(
        getClientFunctions(),
        name,
      )(data);
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
    const result = await run("send", "sendInvoiceEmail", { invoiceId }, "Couldn't send the invoice. Try again.");
    if (result) toast.success(`Invoice ${invoiceId} sent to ${invoice!.customer.email}.`);
  }

  async function previewPdf() {
    const result = await run<{ pdfBase64: string; contentType: string; filename: string }>(
      "pdf",
      "previewInvoicePDF",
      { invoiceId },
      "Couldn't create the PDF. Try again.",
    );
    if (result) {
      const blob = base64ToBlob(result.pdfBase64, result.contentType || "application/pdf");
      setPdf({ url: URL.createObjectURL(blob), filename: result.filename });
    }
  }

  async function copyPayLink() {
    if (!payLink) return;
    try {
      await navigator.clipboard.writeText(payLink);
      toast.success("Pay link copied.");
    } catch {
      toast.error("Couldn't copy the link. Select it under Pay link and copy it.");
    }
  }

  async function markPaid() {
    const result = await run("paid", "markInvoicePaid", { invoiceId, paymentMethod: method, sendReceipt }, "Couldn't record the payment. Try again.");
    if (result) {
      setMarkPaidOpen(false);
      toast.success(
        sendReceipt
          ? `${invoiceId} marked as paid. A receipt is on its way to ${invoice!.customer.email}.`
          : `${invoiceId} marked as paid.`,
      );
    }
  }

  async function voidIt() {
    const result = await run("void", "voidInvoice", { invoiceId, reason: voidReason.trim() || null }, "Couldn't void the invoice. Try again.");
    if (result) {
      setVoidOpen(false);
      toast.success(`${invoiceId} is void. Its pay link no longer works.`);
    }
  }

  async function deleteDraft() {
    const result = await run("delete", "deleteInvoice", { invoiceId }, "Couldn't delete the draft. Try again.");
    if (result) {
      setDeleteOpen(false);
      toast.success(`Draft ${invoiceId} deleted.`);
      router.replace("/invoices");
    }
  }

  async function reissuePayLink() {
    const result = await run("reissue", "regenerateInvoicePayLink", { invoiceId }, "Couldn't issue a new pay link. Try again.");
    if (result) {
      setReissueOpen(false);
      toast.success(
        invoice!.status === "draft"
          ? "New pay link issued."
          : "New pay link issued. Send the invoice again so your customer gets it.",
      );
    }
  }

  const activity: { label: string; value: string; detail?: string | null }[] = [];
  const created = formatTimestamp(invoice.createdAt);
  if (created) activity.push({ label: "Created", value: created });
  const sent = formatTimestamp(invoice.sentAt);
  if (sent) activity.push({ label: "Sent", value: sent });
  const paid = formatTimestamp(invoice.paidAt);
  if (paid) {
    const paidAmount = invoice.paidAmountCents ?? null;
    activity.push({
      label: "Paid",
      value: paid,
      detail: [
        paymentMethodLabel(invoice.paymentMethod),
        paidAmount != null ? formatMoneyCents(paidAmount, currency) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  const refunded = formatTimestamp(invoice.refundedAt);
  if (refunded) {
    activity.push({
      label: "Refunded",
      value: refunded,
      detail: invoice.refundedAmountCents != null ? formatMoneyCents(invoice.refundedAmountCents, currency) : null,
    });
  }
  const disputed = formatTimestamp(invoice.disputedAt);
  if (disputed) {
    activity.push({
      label: invoice.disputeOutcome ? `Dispute ${invoice.disputeOutcome}` : "Disputed",
      value: disputed,
      detail: invoice.disputeReason ?? null,
    });
  }
  const voided = formatTimestamp(invoice.voidedAt);
  if (voided) activity.push({ label: "Voided", value: voided, detail: invoice.voidReason ?? null });

  const emailStatus = invoice.lastEmailStatus ? EMAIL_STATUS[invoice.lastEmailStatus] : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">{invoice.id}</h1>
            <InvoiceStatusBadge status={status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {invoice.customer.name} · {money(invoice.totals.total)}
            {pastDueDays > 0 ? ` · ${pastDueDays} day${pastDueDays === 1 ? "" : "s"} overdue` : ""}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {actions.send || actions.resend ? (
            <Button onClick={send} disabled={busy !== null || !canCollect}>
              {busy === "send" ? "Sending…" : actions.send ? "Send invoice" : "Resend"}
            </Button>
          ) : null}
          {actions.markPaid ? (
            <Button variant="outline" onClick={() => setMarkPaidOpen(true)} disabled={busy !== null}>
              Mark as paid
            </Button>
          ) : null}
          {actions.copyPayLink && payLink && !payLinkExpired ? (
            <Button variant="outline" onClick={copyPayLink} disabled={busy !== null}>
              Copy pay link
            </Button>
          ) : null}
          <Button variant="outline" onClick={previewPdf} disabled={busy !== null}>
            {busy === "pdf" ? "Creating PDF…" : "Preview PDF"}
          </Button>
          {actions.void ? (
            <Button variant="destructive" onClick={() => setVoidOpen(true)} disabled={busy !== null}>
              Void
            </Button>
          ) : null}
          {actions.deleteDraft ? (
            <Button variant="destructive" onClick={() => setDeleteOpen(true)} disabled={busy !== null}>
              Delete draft
            </Button>
          ) : null}
        </div>
      </div>

      {(actions.send || actions.resend) && !canCollect ? (
        <Alert>
          <AlertTitle>Set up a way to get paid before sending</AlertTitle>
          <AlertDescription>
            Add an e-Transfer email or connect Stripe.{" "}
            <Link href="/settings/payments" className="font-medium underline underline-offset-4">
              Payment settings
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      {invoice.status === "void" ? (
        <Alert>
          <AlertTitle>This invoice is void</AlertTitle>
          <AlertDescription>
            It stays on record, and its pay link no longer works.
            {invoice.voidReason ? ` Reason: ${invoice.voidReason}` : ""}
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
            <iframe title={`${invoice.id} PDF preview`} src={pdf.url} className="h-[70vh] w-full rounded-md border bg-white" />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card>
            <CardContent className="grid gap-6 sm:grid-cols-2">
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-xs font-medium text-muted-foreground">Bill to</span>
                <span className="font-medium">{invoice.customer.name}</span>
                <span className="break-all">{invoice.customer.email}</span>
                {invoice.customer.phone ? <span>{invoice.customer.phone}</span> : null}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Issued</dt>
                <dd>{formatIsoDate(invoice.issueDate)}</dd>
                <dt className="text-muted-foreground">Due</dt>
                <dd>{formatIsoDate(invoice.dueDate)}</dd>
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
                  {invoice.lineItems.map((line, index) => (
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
                  <dd>{money(invoice.totals.subtotal)}</dd>
                </div>
                {invoice.totals.taxes.map((tax) => (
                  <div key={tax.name} className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">
                      {tax.name} ({Math.round(tax.rate * 10000) / 100}%)
                      {tax.taxableAmount !== invoice.totals.subtotal ? ` on ${money(tax.taxableAmount)}` : ""}
                    </dt>
                    <dd>{money(tax.amount)}</dd>
                  </div>
                ))}
                <div className="flex items-baseline justify-between gap-4 border-t pt-2">
                  <dt className="font-medium">Total</dt>
                  <dd className="text-base font-semibold">{money(invoice.totals.total)}</dd>
                </div>
                {invoice.surchargeAmountCents ? (
                  <>
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Card fee</dt>
                      <dd>{formatMoneyCents(invoice.surchargeAmountCents, currency)}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Total charged</dt>
                      <dd>{formatMoneyCents(dollarsToCents(invoice.totals.total) + invoice.surchargeAmountCents, currency)}</dd>
                    </div>
                  </>
                ) : null}
                {invoice.status === "partial" ? (
                  <div className="flex justify-between gap-4 font-medium">
                    <dt>Balance due</dt>
                    <dd>{formatMoneyCents(balanceDueCents(invoice), currency)}</dd>
                  </div>
                ) : null}
              </dl>
            </CardContent>
          </Card>

          {invoice.notes ? (
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
                <CardDescription>Shown to your customer on the invoice.</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-line">{invoice.notes}</p>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              <ol className="flex flex-col gap-3">
                {activity.map((item) => (
                  <li key={item.label} className="flex flex-col">
                    <span className="font-medium">{item.label}</span>
                    <span className="text-muted-foreground">{item.value}</span>
                    {item.detail ? <span className="text-muted-foreground">{item.detail}</span> : null}
                  </li>
                ))}
              </ol>
              {emailStatus ? (
                <div className="flex flex-col gap-1 border-t pt-4">
                  <span className="text-xs font-medium text-muted-foreground">Last email</span>
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant={emailStatus.tone}>{emailStatus.label}</Badge>
                    {formatTimestamp(invoice.lastEmailStatusAt) ? (
                      <span className="text-muted-foreground">{formatTimestamp(invoice.lastEmailStatusAt)}</span>
                    ) : null}
                  </span>
                  {invoice.lastEmailStatusDetail ? (
                    <span className="text-muted-foreground">{invoice.lastEmailStatusDetail}</span>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>

          {actions.copyPayLink && payLink ? (
            <Card>
              <CardHeader>
                <CardTitle>Pay link</CardTitle>
                <CardDescription>
                  {payLinkExpired
                    ? "This link has expired."
                    : invoice.payTokenExpiresAt
                      ? `Works until ${new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" }).format(invoice.payTokenExpiresAt.toDate())}.`
                      : "Works until it's replaced."}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {!payLinkExpired ? (
                  <>
                    <Label htmlFor="invoice-pay-link" className="sr-only">
                      Pay link
                    </Label>
                    <Input
                      id="invoice-pay-link"
                      readOnly
                      value={payLink}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  </>
                ) : null}
                {actions.reissuePayLink ? (
                  <Button variant="outline" size="sm" className="w-fit" onClick={() => setReissueOpen(true)} disabled={busy !== null}>
                    Issue a new link
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      <Dialog open={markPaidOpen} onOpenChange={setMarkPaidOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record a payment</DialogTitle>
            <DialogDescription>
              For money received outside the pay link. Card payments through
              the link are recorded automatically.
            </DialogDescription>
          </DialogHeader>
          <RadioGroup
            aria-label="Payment method"
            value={method}
            onValueChange={(value) => setMethod(value as ManualMethod)}
          >
            {MANUAL_PAYMENT_METHODS.map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <RadioGroupItem value={value} />
                {value === "manual" ? "Other" : PAYMENT_METHOD_LABELS[value]}
              </label>
            ))}
          </RadioGroup>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={sendReceipt} onCheckedChange={(checked) => setSendReceipt(checked === true)} />
            Email a receipt to {invoice.customer.email}
          </label>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button onClick={markPaid} disabled={busy !== null}>
              {busy === "paid" ? "Saving…" : "Mark as paid"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={voidOpen} onOpenChange={setVoidOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Void {invoice.id}?</AlertDialogTitle>
            <AlertDialogDescription>
              The invoice stays on record marked void and its pay link stops
              working. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="invoice-void-reason">Reason (optional)</Label>
            <Textarea
              id="invoice-void-reason"
              rows={2}
              maxLength={500}
              value={voidReason}
              onChange={(event) => setVoidReason(event.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep invoice</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={voidIt} disabled={busy !== null}>
              {busy === "void" ? "Voiding…" : "Void invoice"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete draft {invoice.id}?</AlertDialogTitle>
            <AlertDialogDescription>
              The draft was never sent, so no customer has this number. This
              can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep draft</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={deleteDraft} disabled={busy !== null}>
              {busy === "delete" ? "Deleting…" : "Delete draft"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={reissueOpen} onOpenChange={setReissueOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Issue a new pay link?</AlertDialogTitle>
            <AlertDialogDescription>
              The current link stops working. Send the invoice again so your
              customer gets the new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={reissuePayLink} disabled={busy !== null}>
              {busy === "reissue" ? "Issuing…" : "Issue new link"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
