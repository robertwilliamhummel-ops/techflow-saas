"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { httpsCallable } from "firebase/functions";
import * as Sentry from "@sentry/nextjs";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getClientFunctions } from "@/lib/firebase/client";
import { useAuth } from "@/lib/auth/useAuth";

interface CompleteResult {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  currentlyDue: string[];
  disabledReason: string | null;
}

type Phase =
  | { kind: "loading" }
  | { kind: "success"; result: CompleteResult }
  | { kind: "error"; message: string };

export default function BillingReturnPage() {
  const { user, loading: authLoading } = useAuth();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    if (authLoading || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const fn = httpsCallable<unknown, CompleteResult>(
          getClientFunctions(),
          "completeConnectOnboarding",
        );
        const { data } = await fn({});
        if (!cancelled) setPhase({ kind: "success", result: data });
      } catch (err) {
        Sentry.captureException(err);
        const message =
          err instanceof Error ? err.message : "Could not finalize Stripe setup.";
        if (!cancelled) setPhase({ kind: "error", message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, user]);

  if (phase.kind === "loading") {
    return (
      <div className="p-8 max-w-2xl">
        <h1 className="text-2xl font-semibold">Finishing Stripe setup…</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Confirming your account with Stripe. This usually takes a few seconds.
        </p>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="p-8 max-w-2xl">
        <h1 className="text-2xl font-semibold">Stripe setup didn&apos;t finish</h1>
        <Alert className="mt-4" variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{phase.message}</AlertDescription>
        </Alert>
        <div className="mt-4">
          <Link href="/billing" className={buttonVariants()}>
            Back to Billing
          </Link>
        </div>
      </div>
    );
  }

  const { chargesEnabled, payoutsEnabled, detailsSubmitted, currentlyDue, disabledReason } =
    phase.result;

  const isFullyReady = chargesEnabled && payoutsEnabled && currentlyDue.length === 0;

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-semibold">
        {isFullyReady ? "You're ready to accept payments" : "Stripe setup in progress"}
      </h1>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Account status</CardTitle>
          <CardDescription>
            Mirrored from Stripe just now.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Accept payments</dt>
            <dd>{chargesEnabled ? "Yes" : "Not yet"}</dd>
            <dt className="text-muted-foreground">Receive payouts</dt>
            <dd>{payoutsEnabled ? "Yes" : "Not yet"}</dd>
            <dt className="text-muted-foreground">Details submitted</dt>
            <dd>{detailsSubmitted ? "Yes" : "No"}</dd>
          </dl>

          {disabledReason ? (
            <Alert variant="destructive">
              <AlertTitle>Stripe has paused this account</AlertTitle>
              <AlertDescription>
                Reason: {disabledReason}. Resolve in Stripe and check back here.
              </AlertDescription>
            </Alert>
          ) : null}

          {currentlyDue.length > 0 ? (
            <Alert>
              <AlertTitle>Stripe needs more information</AlertTitle>
              <AlertDescription>
                Outstanding requirements: {currentlyDue.join(", ")}.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="flex gap-2">
            <Link href="/billing" className={buttonVariants()}>
              Back to Billing
            </Link>
            {isFullyReady ? (
              <Link
                href="/invoices"
                className={buttonVariants({ variant: "outline" })}
              >
                Create an invoice
              </Link>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
