// Mirror of src/lib/features.ts — duplicated here because the functions package
// compiles separately (rootDir: src). Keep in sync when adding new flags.

export const FEATURE_DEFAULTS = {
  invoices: true,
  recurringInvoices: false,
  quotes: true,
  customDomain: false,
  stripeConnect: false,
  stripePayments: false,
  etransfer: true,
  multiCurrency: false,
  // D3 — card surcharging ships disabled. Checkout cannot tell credit from
  // debit/prepaid, and Visa/Mastercard forbid surcharging those. Enable per
  // tenant only once card-funding detection is available.
  cardSurcharge: false,
} as const;

export type FeatureKey = keyof typeof FEATURE_DEFAULTS;

export function resolveFeature(
  key: FeatureKey,
  tenantOverrides: Partial<Record<FeatureKey, boolean>> | null | undefined,
): boolean {
  if (tenantOverrides && key in tenantOverrides) {
    const v = tenantOverrides[key];
    if (typeof v === "boolean") return v;
  }
  return FEATURE_DEFAULTS[key];
}
