// D2 — every deployed function lands in a Canadian region. Guards against a
// future import reordering in src/index.ts silently deploying to us-central1.

import { describe, expect, it } from "vitest";
import "../callables/_setup";
import * as functions from "../../src/index";
import {
  FUNCTIONS_REGION,
  SCHEDULER_REGION,
} from "../../src/shared/globalOptions";

const SCHEDULED = new Set([
  "scheduledFirestoreExport",
  "processRecurringInvoices",
  "recheckPendingDomains",
]);

type WithEndpoint = { __endpoint: { region?: string[] } };

const deployed = Object.entries(functions).filter(
  ([, value]) =>
    typeof value === "function" && "__endpoint" in (value as object),
) as Array<[string, WithEndpoint]>;

describe("function regions (D2)", () => {
  it("discovers the exported functions", () => {
    expect(deployed.length).toBeGreaterThan(20);
  });

  for (const [name, fn] of deployed) {
    const expected = SCHEDULED.has(name) ? SCHEDULER_REGION : FUNCTIONS_REGION;
    it(`${name} deploys to ${expected}`, () => {
      expect(fn.__endpoint.region).toEqual([expected]);
    });
  }
});
