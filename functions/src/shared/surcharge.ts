// Surcharge computation — server-side, cannot be set by client.
// Blueprint Phase 4: hard cap at 2.4% (Visa/Mastercard Canadian ceiling).
// Decision D3: gated behind the `cardSurcharge` feature (default off).

export const MAX_SURCHARGE_PERCENT = 2.4;

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

/**
 * The surcharge that actually applies to an invoice: the frozen snapshot is
 * the single source (what the PDF and pay page disclosed), and the platform
 * `cardSurcharge` flag is a kill switch on top. Never reads current meta.
 */
export function effectiveCardSurcharge(
  snapshot: { chargeCustomerCardFees?: unknown; cardFeePercent?: unknown } | null | undefined,
  cardSurchargeFeature: boolean,
): { enabled: boolean; percent: number } {
  const enabled =
    cardSurchargeFeature && snapshot?.chargeCustomerCardFees === true;
  if (!enabled) return { enabled: false, percent: 0 };
  const raw = Number(snapshot?.cardFeePercent ?? 0);
  const percent = Number.isFinite(raw)
    ? Math.min(Math.max(raw, 0), MAX_SURCHARGE_PERCENT)
    : 0;
  return { enabled: percent > 0, percent };
}
