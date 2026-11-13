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

type WithEndpoint = {
  __endpoint: { region?: string[]; cpu?: unknown; availableMemoryMb?: unknown };
};

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

// A full deploy health-checks every function at once; at 1 vCPU each the set
// exceeds a new project's 20 vCPU regional Cloud Run quota, and at the 256 MiB
// default the code's ~270 MiB startup footprint kills every instance
// (globalOptions.ts).
describe("function size", () => {
  for (const [name, fn] of deployed) {
    it(`${name} uses gcf_gen1 CPU and 512 MiB`, () => {
      expect(fn.__endpoint.cpu).toBe("gcf_gen1");
      expect(fn.__endpoint.availableMemoryMb).toBe(512);
    });
  }
});
