// Mirror of src/lib/features.ts — duplicated here because the functions package
// compiles separately (rootDir: src). Keep in sync when adding new flags;
// src/lib/__tests__/features.test.ts pins the two copies together.
//
// Y-04 (2026-09-15): every plan includes every feature, so every default is on
// except card surcharging (D3). The switches stay: a tenant's entitlements
// document can still turn any feature off, and plans can be tiered later
// without code changes.

export const FEATURE_DEFAULTS = {
  invoices: true,
  recurringInvoices: true,
  quotes: true,
  customDomain: true,
  stripeConnect: true,
  stripePayments: true,
  etransfer: true,
  multiCurrency: true,
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
