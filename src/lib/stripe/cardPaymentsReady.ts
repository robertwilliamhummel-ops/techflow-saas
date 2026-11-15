// Whether a business can take card payments: a connected Stripe account that
// Stripe lets take charges. The app's copy of cardPaymentsReady in
// functions/src/shared/payAmounts.ts; a test pins the two together.

export interface StripeReadinessFields {
  stripeAccountId?: unknown;
  stripeStatus?: { chargesEnabled?: unknown } | null;
}

export function cardPaymentsReady(
  meta: StripeReadinessFields | null | undefined,
): boolean {
  return (
    typeof meta?.stripeAccountId === "string" &&
    meta.stripeAccountId.length > 0 &&
    meta.stripeStatus?.chargesEnabled === true
  );
}
