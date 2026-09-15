"use client";

// Building blocks for the public pay pages (S-09): checking the link, the
// business's frame — its colour band, then the page, then its footer, with no
// platform branding (blueprint, "Public pay page") — and the messages for
// every result that isn't a payable invoice.

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { httpsCallable } from "firebase/functions";
import * as Sentry from "@sentry/nextjs";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { computeForeground } from "@/lib/design/contrast";
import { getClientFunctions } from "@/lib/firebase/client";
import { formatDateMillis } from "@/lib/format";
import { payLoadError, type PayLoadError, type VerifyResult } from "@/lib/pay/payPage";
import type { CustomerBusinessView } from "@/lib/portal/portalDocument";
import { portalAccent } from "@/lib/portal/portalHome";

export type PayVerification =
  | { state: "loading" }
  | { state: "error"; error: PayLoadError; retry: () => void }
  | { state: "ready"; result: VerifyResult; recheck: () => void };

interface Checked {
  key: string;
  result: VerifyResult | null;
  error: PayLoadError | null;
}

/**
 * Checks the pay link with verifyInvoicePayToken from the browser, where the
 * Functions client attaches the App Check token (D8).
 */
export function usePayVerification(token: string): PayVerification {
  const [attempt, setAttempt] = useState(0);
  const [checked, setChecked] = useState<Checked | null>(null);
  const key = `${token}:${attempt}`;
  const again = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() =>
        httpsCallable<{ token: string }, VerifyResult>(getClientFunctions(), "verifyInvoicePayToken")({
          token,
        }),
      )
      .then(({ data }) => {
        if (active) setChecked({ key, result: data, error: null });
      })
      .catch((err: unknown) => {
        const error = payLoadError(err);
        if (error === "failed") Sentry.captureException(err);
        if (active) setChecked({ key, result: null, error });
      });
    return () => {
      active = false;
    };
  }, [token, key]);

  if (!checked || checked.key !== key) return { state: "loading" };
  if (checked.error || !checked.result) {
    return { state: "error", error: checked.error ?? "failed", retry: again };
  }
  return { state: "ready", result: checked.result, recheck: again };
}

type FrameBusiness = CustomerBusinessView & { emailFooter?: string | null };

export function PayFrame({
  business,
  children,
}: {
  business: FrameBusiness | null;
  children: ReactNode;
}) {
  const accent = business ? portalAccent(business.primaryColor) : null;

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header
        className={accent ? undefined : "border-b bg-card"}
        style={accent ? { backgroundColor: accent, color: computeForeground(accent) } : undefined}
      >
        <div className="mx-auto flex h-20 w-full max-w-2xl items-center gap-3 px-4">
          {business?.logoUrl ? (
            <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white p-1">
              <Image
                src={business.logoUrl}
                alt=""
                width={48}
                height={48}
                className="max-h-full max-w-full object-contain"
                unoptimized
              />
            </span>
          ) : null}
          <p className="truncate text-lg font-semibold">{business?.name || "Invoice payment"}</p>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-2xl flex-1 content-start gap-6 px-4 py-6 sm:py-8">
        {children}
      </main>

      {business ? (
        <footer className="border-t">
          <div className="mx-auto grid w-full max-w-2xl gap-1 px-4 py-6 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{business.name}</p>
            {business.address ? <p className="whitespace-pre-line">{business.address}</p> : null}
            {business.emailFooter ? (
              <p className="whitespace-pre-line">{business.emailFooter}</p>
            ) : null}
            <p className="mt-2">Questions? Reply to the email that brought you here.</p>
          </div>
        </footer>
      ) : null}
    </div>
  );
}

export function PayMessage({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="grid gap-2 rounded-xl bg-card p-6 ring-1 ring-foreground/10">
      <h1 className="text-xl font-semibold text-balance">{title}</h1>
      <div className="grid gap-2 text-sm text-muted-foreground">{children}</div>
      {action ? <div className="mt-2">{action}</div> : null}
    </section>
  );
}

export function PaySkeleton() {
  return (
    <div role="status" className="grid gap-6">
      <span className="sr-only">Loading the invoice…</span>
      <Skeleton className="h-52 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}

function PortalLink() {
  return (
    <Link href="/portal" className={buttonVariants({ variant: "outline" })}>
      See your invoices
    </Link>
  );
}

/** Every verify result other than a payable invoice. */
export function PayOutcome({ result }: { result: Exclude<VerifyResult, { outcome: "ok" }> }) {
  switch (result.outcome) {
    case "paid": {
      const paidOn = result.paidAt > 0 ? formatDateMillis(result.paidAt) : null;
      return (
        <PayMessage title="This invoice is paid" action={<PortalLink />}>
          <p>
            Invoice {result.invoiceNumber} was paid{paidOn ? ` on ${paidOn}` : ""}. Thank you.
          </p>
        </PayMessage>
      );
    }
    case "refunded": {
      const refundedOn = result.refundedAt > 0 ? formatDateMillis(result.refundedAt) : null;
      return (
        <PayMessage title="This invoice was refunded" action={<PortalLink />}>
          <p>
            The payment for invoice {result.invoiceNumber} was refunded
            {refundedOn ? ` on ${refundedOn}` : ""}.
          </p>
        </PayMessage>
      );
    }
    case "void":
      return (
        <PayMessage title="This invoice was cancelled">
          <p>
            {result.business.name || "The business"} cancelled invoice {result.invoiceNumber}, so
            nothing is owed.
          </p>
        </PayMessage>
      );
    case "regenerated":
      return (
        <PayMessage title="This link has been replaced">
          <p>
            The business sent a newer link for this invoice. Use the link in their most recent
            email.
          </p>
        </PayMessage>
      );
    case "not-available":
      return (
        <PayMessage title="This invoice can't be paid online">
          <p>Contact the business that sent it.</p>
        </PayMessage>
      );
  }
}

export function PayLoadFailed({ error, onRetry }: { error: PayLoadError; onRetry: () => void }) {
  if (error === "invalid-link") {
    return (
      <PayMessage title="This payment link isn't valid">
        <p>
          It may have expired, or part of it may be missing. Ask the business that sent the
          invoice for a new link.
        </p>
      </PayMessage>
    );
  }
  return (
    <Alert variant="destructive">
      <AlertTitle>The invoice didn&apos;t load</AlertTitle>
      <AlertDescription>Check your connection, then try again.</AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </AlertAction>
    </Alert>
  );
}
