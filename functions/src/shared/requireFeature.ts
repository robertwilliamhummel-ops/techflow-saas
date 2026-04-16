import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./admin";
import { type FeatureKey, resolveFeature } from "./features";

export async function requireFeature(
  tenantId: string,
  key: FeatureKey,
): Promise<void> {
  const snap = await db.doc(`tenants/${tenantId}/entitlements/current`).get();
  const overrides = snap.exists
    ? ((snap.data() as { features?: Record<string, boolean> }).features ?? {})
    : {};
  if (!resolveFeature(key, overrides)) {
    throw new HttpsError(
      "permission-denied",
      `Feature '${key}' is not enabled for this tenant.`,
    );
  }
}
