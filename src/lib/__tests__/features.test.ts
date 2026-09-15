import { describe, expect, it } from "vitest";
import {
  FEATURE_DEFAULTS as SERVER_DEFAULTS,
  resolveFeature as serverResolve,
} from "../../../functions/src/shared/features";
import { FEATURE_DEFAULTS, resolveFeature } from "../features";

describe("feature defaults", () => {
  it("match the Cloud Functions copy", () => {
    expect(FEATURE_DEFAULTS).toEqual(SERVER_DEFAULTS);
  });

  it("Y-04: every feature is on by default except card surcharging (D3)", () => {
    for (const [key, value] of Object.entries(FEATURE_DEFAULTS)) {
      expect([key, value]).toEqual([key, key !== "cardSurcharge"]);
    }
  });

  it("still lets a tenant's entitlements turn a feature off, the same way on both sides", () => {
    const overrides = { recurringInvoices: false, cardSurcharge: true };
    for (const key of Object.keys(FEATURE_DEFAULTS) as (keyof typeof FEATURE_DEFAULTS)[]) {
      expect(resolveFeature(key, overrides)).toBe(serverResolve(key, overrides));
    }
    expect(resolveFeature("recurringInvoices", overrides)).toBe(false);
    expect(resolveFeature("cardSurcharge", overrides)).toBe(true);
  });
});
