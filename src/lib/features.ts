// Feature flag registry. Expanded as phases unlock capabilities.
// Flags resolved from tenants/{tenantId}/entitlements.features with fall-through to defaults.
//
// Y-04 (2026-09-15): every plan includes every feature, so every default is on
// except card surcharging (D3). A tenant's entitlements can still turn any
// feature off. Mirrors functions/src/shared/features.ts (pinned by a test).

export const FEATURE_DEFAULTS = {
  invoices: true,
  recurringInvoices: true,
  quotes: true,
  customDomain: true,
  stripeConnect: true,
  stripePayments: true,
  etransfer: true,
  multiCurrency: true,
  // D3 — card surcharging ships disabled (see functions/src/shared/features.ts).
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
