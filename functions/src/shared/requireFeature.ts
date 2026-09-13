import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./admin";
import {
  FEATURE_DEFAULTS,
  type FeatureKey,
  resolveFeature,
} from "./features";

export type ResolvedFeatures = Record<FeatureKey, boolean>;

// One entitlements read, every flag resolved against code defaults.
export async function loadFeatures(tenantId: string): Promise<ResolvedFeatures> {
  const snap = await db.doc(`tenants/${tenantId}/entitlements/current`).get();
  const overrides = snap.exists
    ? ((snap.data() as { features?: Record<string, boolean> }).features ?? {})
    : {};
  const resolved = {} as ResolvedFeatures;
  for (const key of Object.keys(FEATURE_DEFAULTS) as FeatureKey[]) {
    resolved[key] = resolveFeature(key, overrides);
  }
  return resolved;
}

// Throws permission-denied when the flag is off. Returns the resolved map so
// callers that need other flags (e.g. cardSurcharge) don't re-read.
export async function requireFeature(
  tenantId: string,
  key: FeatureKey,
): Promise<ResolvedFeatures> {
  const features = await loadFeatures(tenantId);
  if (!features[key]) {
    throw new HttpsError(
      "permission-denied",
      `Feature '${key}' is not enabled for this tenant.`,
    );
  }
  return features;
}
