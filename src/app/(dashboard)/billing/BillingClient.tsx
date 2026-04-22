"use client";

import { useCallback, useState } from "react";
import { useSearchParams } from "next/navigation";
import { httpsCallable } from "firebase/functions";
import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { getClientFunctions } from "@/lib/firebase/client";
import { useTenantContext } from "@/lib/tenant/TenantContext";

interface StartResult {
  url: string;
  accountId: string;
}

export function BillingClient() {
  const { meta, features, loading } = useTenantContext();
  const searchParams = useSearchParams();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = searchParams.get("stripe") === "refresh";

  const startOnboarding = useCallback(async () => {
    setError(null);
    setSubmitting(true);
    try {
      const fn = httpsCallable<unknown, StartResult>(
        getClientFunctions(),
        "startConnectOnboarding",
      );
      const { data } = await fn({});
      window.location.href = data.url;
    } catch (err) {
      Sentry.captureException(err);
      const message =
        err instanceof Error ? err.message : "Could not start Stripe onboarding.";
      setError(message);
      setSubmitting(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!features.stripePayments) {
    return (
      <div className="p-8 max-w-2xl">
        <h1 className="text-2xl font-semibold">Billing</h1>
        <Alert className="mt-4">
          <AlertTitle>Card payments aren&apos;t included in your plan</AlertTitle>
          <AlertDescription>
            Your customers can still pay by e-transfer. Upgrade your plan to
            accept credit cards through Stripe.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const accountId = meta?.stripeAccountId ?? null;
  const status = meta?.stripeStatus ?? null;
  const chargesEnabled = status?.chargesEnabled === true;
  const payoutsEnabled = status?.payoutsEnabled === true;
  const detailsSubmitted = status?.detailsSubmitted === true;
  const currentlyDue = status?.currentlyDue ?? [];

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-semibold">Billing</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect Stripe so customers can pay invoices by credit card.
      </p>

      {refresh ? (
        <Alert className="mt-4" variant="destructive">
          <AlertTitle>Stripe sent you back without finishing</AlertTitle>
          <AlertDescription>
            You can pick up where you left off — your progress was saved.
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert className="mt-4" variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!accountId ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Connect your Stripe account</CardTitle>
            <CardDescription>
              Stripe handles card processing, payouts, and tax forms. Setup
              takes a few minutes — Stripe will ask for your business details
              and a bank account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              size="lg"
              onClick={startOnboarding}
              disabled={submitting}
            >
              {submitting ? "Opening Stripe…" : "Connect with Stripe"}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Stripe account
              {chargesEnabled ? (
                <Badge variant="default">Active</Badge>
              ) : detailsSubmitted ? (
                <Badge variant="secondary">Pending review</Badge>
              ) : (
                <Badge variant="outline">Setup incomplete</Badge>
              )}
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              {accountId}
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

            {status?.disabledReason ? (
              <Alert variant="destructive">
                <AlertTitle>Stripe has paused this account</AlertTitle>
                <AlertDescription>
                  Reason: {status.disabledReason}. Open Stripe to resolve it.
                </AlertDescription>
              </Alert>
            ) : null}

            {currentlyDue.length > 0 ? (
              <Alert>
                <AlertTitle>Stripe needs more information</AlertTitle>
                <AlertDescription>
                  Outstanding requirements: {currentlyDue.join(", ")}. Resume
                  onboarding to finish.
                </AlertDescription>
              </Alert>
            ) : null}

            {!chargesEnabled || currentlyDue.length > 0 ? (
              <div>
                <Button onClick={startOnboarding} disabled={submitting}>
                  {submitting ? "Opening Stripe…" : "Resume Stripe onboarding"}
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
