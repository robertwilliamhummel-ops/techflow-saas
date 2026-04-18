// Next-side mirror of buildStripeStatusFromAccount from functions/src/shared/stripe.ts.
// Used by the platform webhook to update meta.stripeStatus when an
// account.updated event fires. Kept in a separate file so it can be imported
// without pulling in the Stripe client module.

import { FieldValue } from "firebase-admin/firestore";
import type Stripe from "stripe";

export interface StripeStatusWrite {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  currentlyDue: string[];
  disabledReason: string | null;
  updatedAt: FieldValue;
}

export function buildStripeStatusFromAccount(
  account: Stripe.Account,
): StripeStatusWrite {
  return {
    chargesEnabled: account.charges_enabled === true,
    payoutsEnabled: account.payouts_enabled === true,
    detailsSubmitted: account.details_submitted === true,
    currentlyDue: account.requirements?.currently_due ?? [],
    disabledReason: account.requirements?.disabled_reason ?? null,
    updatedAt: FieldValue.serverTimestamp(),
  };
}
