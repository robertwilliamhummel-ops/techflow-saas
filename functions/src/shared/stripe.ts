// Phase 4 Bundle A — Stripe plumbing.
//
// Lazy Stripe client + idempotency + status writer. Imported by Connect
// onboarding callables, both webhook routes, and createPayTokenCheckoutSession.
//
// Idempotency uses stripeEvents/{event.id} as a sentinel doc. Webhooks read it
// before dispatching; if it already exists, the event is a redelivery and the
// handler short-circuits. Stripe redelivers up to 3 days for unacked events,
// and a single retried event without idempotency would double-mark an invoice
// paid. Round-3 CRITICAL — folded into the main plan.

import { defineSecret } from "firebase-functions/params";
import Stripe from "stripe";
import { db, FieldValue, Timestamp } from "./admin";
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

// Try to claim the event for processing. Returns true if this caller owns it
// (first delivery), false if another invocation already recorded it.
//
// Uses a transaction so two concurrent webhook deliveries of the same event
// can't both decide they're the first one through.
export async function claimStripeEvent(
  eventId: string,
  meta: {
    type: string;
    account: string | null;
    livemode: boolean;
  },
): Promise<boolean> {
  const ref = db.doc(`stripeEvents/${eventId}`);
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.set(ref, {
      type: meta.type,
      account: meta.account,
      livemode: meta.livemode,
      receivedAt: FieldValue.serverTimestamp(),
      // 30-day TTL via Firestore TTL policy on `expireAt` (configured per-project,
      // same pattern as payAttempts.expireAt). Stripe redelivers for up to 3 days,
      // so 30 days is comfortably past any retry window.
      expireAt: Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    return true;
  });
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
