"use client";

// Public pay page (S-09): the invoice in the business's branding, then the ways
// to pay — Interac e-Transfer first, then card through Stripe Checkout on the
// business's own account (blueprint, "Public pay page").

import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { ChevronDown, Copy } from "lucide-react";
import { toast } from "sonner";
import * as Sentry from "@sentry/nextjs";

import {
  PayFrame,
  PayLoadFailed,
  PayOutcome,
  PaySkeleton,
  usePayVerification,
} from "@/components/pay/PayFrame";
import { DocumentTotals, LineItems } from "@/components/portal/PortalDocument";
import { Button } from "@/components/ui/button";
import { computeForeground } from "@/lib/design/contrast";
import { getClientFunctions } from "@/lib/firebase/client";
import { formatIsoDate, formatMoneyCents } from "@/lib/format";
import { localIsoDate } from "@/lib/invoices/dueStatus";
import {
  CHECKOUT_FAILED_MESSAGE,
  checkoutErrorMessage,
  etransferCopyText,
  exceedsTypicalEtransferLimit,
  formatFeePercent,
  isPastDueDate,
  type PayPageInvoice,
} from "@/lib/pay/payPage";
import { portalAccent } from "@/lib/portal/portalHome";
import { cn } from "@/lib/utils";

export function PayInvoice({ token }: { token: string }) {
  const verification = usePayVerification(token);
  const [today] = useState(() => localIsoDate(new Date()));

  if (verification.state === "loading") {
    return (
      <PayFrame business={null}>
        <PaySkeleton />
      </PayFrame>
    );
  }
  if (verification.state === "error") {
    return (
      <PayFrame business={null}>
        <PayLoadFailed error={verification.error} onRetry={verification.retry} />
      </PayFrame>
    );
  }

  const { result } = verification;
  if (result.outcome !== "ok") {
    return (
      <PayFrame business={"business" in result ? result.business : null}>
        <PayOutcome result={result} />
      </PayFrame>
    );
  }

  return (
    <PayFrame business={result.invoice.business}>
      <InvoiceSummary invoice={result.invoice} today={today} />
      <PaymentOptions token={token} invoice={result.invoice} />
    </PayFrame>
  );
}

function InvoiceSummary({ invoice, today }: { invoice: PayPageInvoice; today: string }) {
  const currency = invoice.business.currency;
  const late = isPastDueDate(invoice.status, invoice.dueDate, today);

  return (
    <section
      aria-labelledby="pay-invoice"
      className="grid gap-5 rounded-xl bg-card p-5 ring-1 ring-foreground/10 sm:p-6"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="grid gap-1">
          <h1 id="pay-invoice" className="text-sm text-muted-foreground">
            Invoice <span className="font-mono font-medium text-foreground">{invoice.invoiceNumber}</span>
          </h1>
          <p className="text-4xl font-semibold tracking-tight tabular-nums">
            {formatMoneyCents(invoice.amountDueCents, currency)}
          </p>
          {invoice.customerName ? (
            <p className="text-sm text-muted-foreground">Billed to {invoice.customerName}</p>
          ) : null}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Issued</dt>
          <dd>{formatIsoDate(invoice.issueDate)}</dd>
          <dt className="text-muted-foreground">Due</dt>
          <dd className={late ? "font-medium text-destructive" : undefined}>
            {formatIsoDate(invoice.dueDate)}
            {late ? " · Overdue" : ""}
          </dd>
        </dl>
      </div>

      <details className="group rounded-lg ring-1 ring-foreground/10">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
          Itemized view
          <ChevronDown
            aria-hidden
            className="size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
          />
        </summary>
        <div className="grid gap-4 border-t px-4 py-4">
          <LineItems lines={invoice.lineItems} currency={currency} />
          <DocumentTotals totals={invoice.totals} currency={currency} />
        </div>
      </details>
    </section>
  );
}

function PaymentOptions({ token, invoice }: { token: string; invoice: PayPageInvoice }) {
  const business = invoice.business;

  return (
    <section aria-labelledby="pay-options" className="grid gap-3">
      <h2 id="pay-options" className="text-base font-semibold">
        How to pay
      </h2>
      {invoice.etransfer ? (
        <EtransferOption
          email={invoice.etransfer.email}
          invoice={invoice}
          cardFeeApplies={Boolean(invoice.card && invoice.card.feeCents > 0)}
        />
      ) : null}
      {invoice.card ? <CardOption token={token} invoice={invoice} card={invoice.card} /> : null}
      {!invoice.etransfer && !invoice.card ? (
        <p className="rounded-xl bg-card p-5 text-sm ring-1 ring-foreground/10">
          To pay this invoice, contact {business.name || "the business that sent it"}.
        </p>
      ) : null}
    </section>
  );
}

function EtransferOption({
  email,
  invoice,
  cardFeeApplies,
}: {
  email: string;
  invoice: PayPageInvoice;
  cardFeeApplies: boolean;
}) {
  const currency = invoice.business.currency;
  const name = invoice.business.name || "the business";

  async function copyDetails() {
    try {
      await navigator.clipboard.writeText(
        etransferCopyText(email, invoice.amountDueCents, currency, invoice.invoiceNumber),
      );
      toast.success("e-Transfer details copied.");
    } catch {
      toast.error("Couldn't copy. Select the details and copy them instead.");
    }
  }

  return (
    <article
      aria-labelledby="pay-etransfer"
      className="grid gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="pay-etransfer" className="font-semibold">
          Interac e-Transfer
        </h3>
        {cardFeeApplies ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            No card fee
          </span>
        ) : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Send to</dt>
        <dd className="font-medium wrap-anywhere">{email}</dd>
        <dt className="text-muted-foreground">Amount</dt>
        <dd className="font-medium tabular-nums">
          {formatMoneyCents(invoice.amountDueCents, currency)}
        </dd>
        <dt className="text-muted-foreground">Message</dt>
        <dd className="font-mono font-medium">{invoice.invoiceNumber}</dd>
      </dl>
      <p className="text-sm text-muted-foreground">
        Send it from your bank&apos;s app or website, with the invoice number in the message so{" "}
        {name} can match your payment.
      </p>
      {exceedsTypicalEtransferLimit(invoice.amountDueCents) ? (
        <p className="text-sm text-muted-foreground">
          Most Canadian banks allow up to $3,000 in a single e-Transfer, so you may need to send
          more than one{invoice.card ? ", or pay by card" : ""}.
        </p>
      ) : null}
      <Button variant="outline" onClick={copyDetails} className="w-full sm:w-fit">
        <Copy aria-hidden data-icon="inline-start" />
        Copy details
      </Button>
    </article>
  );
}

function CardOption({
  token,
  invoice,
  card,
}: {
  token: string;
  invoice: PayPageInvoice;
  card: NonNullable<PayPageInvoice["card"]>;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currency = invoice.business.currency;
  const accent = portalAccent(invoice.business.primaryColor);
  const total = formatMoneyCents(card.totalCents, currency);

  async function startCheckout() {
    setStarting(true);
    setError(null);
    try {
      const { data } = await httpsCallable<{ token: string }, { url: string }>(
        getClientFunctions(),
        "createPayTokenCheckoutSession",
      )({ token });
      // Stays "Opening checkout…" while the browser leaves for Stripe.
      window.location.assign(data.url);
    } catch (err) {
      const message = checkoutErrorMessage(err);
      if (message === CHECKOUT_FAILED_MESSAGE) Sentry.captureException(err);
      setError(message);
      setStarting(false);
    }
  }

  return (
    <article
      aria-labelledby="pay-card"
      className="grid gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
    >
      <h3 id="pay-card" className="font-semibold">
        Card
      </h3>
      {card.feeCents > 0 ? (
        // Card rules require the fee, in percent and dollars, before payment.
        <p className="text-sm">
          A {formatFeePercent(card.feePercent)} card processing fee of{" "}
          {formatMoneyCents(card.feeCents, currency)} applies, so you&apos;ll pay{" "}
          <strong className="font-semibold">{total}</strong> by card.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          You&apos;ll enter your card on Stripe&apos;s secure checkout page.
        </p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        onClick={startCheckout}
        disabled={starting}
        className={cn(
          "inline-flex h-11 w-full items-center justify-center rounded-lg px-6 text-base font-medium outline-none transition-opacity hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60 sm:w-fit",
        )}
        style={{ backgroundColor: accent, color: computeForeground(accent) }}
      >
        {starting ? "Opening checkout…" : `Pay ${total} by card`}
      </button>
    </article>
  );
}
