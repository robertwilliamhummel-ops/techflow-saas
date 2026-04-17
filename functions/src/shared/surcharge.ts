// Surcharge computation — server-side, cannot be set by client.
// Blueprint Phase 4: hard cap at 2.4% (Visa/Mastercard Canadian ceiling).

const MAX_SURCHARGE_PERCENT = 2.4;

/**
 * Compute the surcharge in cents for a given invoice total.
 * Returns 0 if surcharging is disabled or the percent is zero/negative.
 */
export function computeSurchargeCents(
  invoiceTotalCents: number,
  chargeCustomerCardFees: boolean,
  cardFeePercent: number,
): number {
  if (!chargeCustomerCardFees) return 0;
  const percent = Math.min(
    Math.max(cardFeePercent, 0),
    MAX_SURCHARGE_PERCENT,
  );
  if (percent === 0) return 0;
  return Math.round(invoiceTotalCents * (percent / 100));
}
