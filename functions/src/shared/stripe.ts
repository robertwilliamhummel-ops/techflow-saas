// Phase 4 Bundle A — Stripe plumbing.
//
// Lazy Stripe client + status writer for the Connect onboarding callables.
// Webhook event idempotency lives with the webhook routes on the Next.js side
// (src/lib/stripe/idempotency.ts, A-03).

import { defineSecret } from "firebase-functions/params";
import Stripe from "stripe";
import { FieldValue } from "./admin";
import type { StripeStatus } from "./schema";

export const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
export const STRIPE_PLATFORM_WEBHOOK_SECRET = defineSecret(
  "STRIPE_PLATFORM_WEBHOOK_SECRET",
);
export const STRIPE_CONNECT_WEBHOOK_SECRET = defineSecret(
  "STRIPE_CONNECT_WEBHOOK_SECRET",
);

let cachedClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (cachedClient) return cachedClient;
  const key = STRIPE_SECRET_KEY.value();
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }
  cachedClient = new Stripe(key);
  return cachedClient;
}

// Test seam — vitest can swap in a fake Stripe client without going through
// firebase-functions params resolution.
export function __setStripeClientForTest(client: Stripe | null): void {
  cachedClient = client;
}

// Mirror Stripe's account capability state into tenants/{id}/meta/settings.
// Sole writer of meta.stripeStatus — invoked from completeConnectOnboarding
// (Bundle B) and the platform-webhook account.updated handler (Bundle C/D).
export function buildStripeStatusFromAccount(
  account: Stripe.Account,
): StripeStatus {
  return {
    chargesEnabled: account.charges_enabled === true,
    payoutsEnabled: account.payouts_enabled === true,
    detailsSubmitted: account.details_submitted === true,
    currentlyDue: account.requirements?.currently_due ?? [],
    disabledReason: account.requirements?.disabled_reason ?? null,
    updatedAt: FieldValue.serverTimestamp(),
  };
}
