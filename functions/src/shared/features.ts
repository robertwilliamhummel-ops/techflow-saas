// Mirror of src/lib/features.ts — duplicated here because the functions package
// compiles separately (rootDir: src). Keep in sync when adding new flags.

export const FEATURE_DEFAULTS = {
  recurringInvoices: false,
  quotes: true,
  customDomain: false,
  stripeConnect: false,
  etransfer: true,
  multiCurrency: false,
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
