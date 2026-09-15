"use client";

// Where Stripe Checkout returns after a card payment (S-09). The Stripe webhook
// records the payment, not this page (Stripe: fulfilment must not depend on the
// customer reaching it), so the page checks the link and, if the payment
// hasn't landed yet, checks once more a few seconds later.

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  PayFrame,
  PayLoadFailed,
  PayMessage,
  PayOutcome,
  usePayVerification,
} from "@/components/pay/PayFrame";
import { buttonVariants } from "@/components/ui/button";

const RECHECK_AFTER_MS = 3_000;

export function PaySuccess({ token }: { token: string }) {
  const verification = usePayVerification(token);
  const [rechecked, setRechecked] = useState(false);
  const notYetRecorded =
    verification.state === "ready" && verification.result.outcome === "ok";
  const recheck = verification.state === "ready" ? verification.recheck : null;

  useEffect(() => {
    if (!notYetRecorded || rechecked || !recheck) return;
    const timer = setTimeout(() => {
      setRechecked(true);
      recheck();
    }, RECHECK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [notYetRecorded, rechecked, recheck]);

  if (verification.state === "error") {
    return (
      <PayFrame business={null}>
        <PayLoadFailed error={verification.error} onRetry={verification.retry} />
      </PayFrame>
    );
  }

  if (verification.state === "loading" || (notYetRecorded && !rechecked)) {
    const business =
      verification.state === "ready" && verification.result.outcome === "ok"
        ? verification.result.invoice.business
        : null;
    return (
      <PayFrame business={business}>
        <PayMessage title="Confirming your payment…">
          <p role="status">This takes a few seconds.</p>
        </PayMessage>
      </PayFrame>
    );
  }

  const { result } = verification;

  if (result.outcome === "paid") {
    return (
      <PayFrame business={result.business}>
        <PayMessage
          title="Payment received"
          action={
            <Link href="/portal" className={buttonVariants({ variant: "outline" })}>
              See your invoices
            </Link>
          }
        >
          <p>
            Thank you. {result.business.name || "The business"} has your payment for invoice{" "}
            {result.invoiceNumber}, and a receipt is on its way to your email.
          </p>
        </PayMessage>
      </PayFrame>
    );
  }

  if (result.outcome === "ok") {
    const name = result.invoice.business.name || "the business";
    return (
      <PayFrame business={result.invoice.business}>
        <PayMessage title="Your payment is being confirmed">
          <p>
            Stripe accepted your card payment, and it can take a minute to reach {name}.
            You&apos;ll get a receipt by email once it does — there&apos;s no need to pay again.
          </p>
        </PayMessage>
      </PayFrame>
    );
  }

  if (result.outcome === "regenerated") {
    return (
      <PayFrame business={null}>
        <PayMessage title="This link was replaced">
          <p>
            The business sent a newer link for this invoice while you were paying, so a payment
            made through this link is refunded automatically. Use the link in their most recent
            email.
          </p>
        </PayMessage>
      </PayFrame>
    );
  }

  return (
    <PayFrame business={"business" in result ? result.business : null}>
      <PayOutcome result={result} />
    </PayFrame>
  );
}
