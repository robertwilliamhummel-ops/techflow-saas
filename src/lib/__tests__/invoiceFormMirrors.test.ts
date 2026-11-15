// The invoice form previews totals and pre-checks dates and emails with client
// copies of Cloud Functions logic. These tests run both copies on the same
// inputs, so a change to one without the other fails here.

import { describe, expect, it } from "vitest";
import {
  computeInvoiceTotals as serverTotals,
  computeLineItems as serverLineItems,
} from "../../../functions/src/shared/invoice";
import { isIsoCalendarDate as serverIsDate } from "../../../functions/src/shared/dates";
import { isValidEmail as serverIsEmail } from "../../../functions/src/shared/email";
import { computeDraftTotals, draftLineAmount } from "@/lib/invoices/draftTotals";
import { addDaysIso, isIsoCalendarDate } from "@/lib/isoDate";
import { isValidEmail } from "@/lib/email";

describe("computeDraftTotals matches Cloud Functions", () => {
  const cases: Array<{
    label: string;
    lines: { description: string; quantity: number; rate: number; taxable: boolean }[];
    tax: { rate: number; name: string };
  }> = [
    {
      label: "all taxable, HST",
      lines: [
        { description: "Faucet install", quantity: 2, rate: 150, taxable: true },
        { description: "Service call", quantity: 1, rate: 85, taxable: true },
      ],
      tax: { rate: 0.13, name: "HST" },
    },
    {
      label: "mixed taxability (D4)",
      lines: [
        { description: "Cleaning", quantity: 1, rate: 100, taxable: true },
        { description: "Exam", quantity: 1, rate: 50, taxable: false },
      ],
      tax: { rate: 0.13, name: "HST" },
    },
    {
      label: "fractional quantities and cents that round",
      lines: [
        { description: "Labour", quantity: 1.25, rate: 89.99, taxable: true },
        { description: "Parts", quantity: 3, rate: 0.335, taxable: true },
        { description: "Disposal", quantity: 0.5, rate: 17.01, taxable: false },
      ],
      tax: { rate: 0.05, name: "GST" },
    },
    {
      label: "exact half-cents floating point stores below .5 (audit 2026-11-13)",
      lines: [
        { description: "Quarter hour", quantity: 0.25, rate: 64.1, taxable: true },
        { description: "Clips", quantity: 1.5, rate: 0.69, taxable: true },
        { description: "Small part", quantity: 1, rate: 0.7, taxable: true },
      ],
      tax: { rate: 0.05, name: "GST" },
    },
    {
      label: "no tax configured",
      lines: [{ description: "Consult", quantity: 1, rate: 200, taxable: true }],
      tax: { rate: 0, name: "" },
    },
    {
      label: "nothing taxable",
      lines: [{ description: "Exempt", quantity: 4, rate: 12.5, taxable: false }],
      tax: { rate: 0.13, name: "HST" },
    },
  ];

  it.each(cases)("$label", ({ lines, tax }) => {
    expect(computeDraftTotals(lines, tax)).toEqual(serverTotals(lines, tax));
  });

  it("rounds each line to cents like the server", () => {
    expect(draftLineAmount({ quantity: 3, rate: 0.335 })).toBe(1.01);
  });

  it("rounds exact half-cents up: 0.25 h x $64.10 is $16.03, 1.5 x $0.69 is $1.04", () => {
    expect(draftLineAmount({ quantity: 0.25, rate: 64.1 })).toBe(16.03);
    expect(draftLineAmount({ quantity: 1.5, rate: 0.69 })).toBe(1.04);
  });

  it("agrees with the server, and with exact integer math, on every quarter hour at sampled rates", () => {
    // Exact cents of (q4 / 4) x (rc / 100), rounded half up.
    const exactCents = (q4: number, rc: number) => Math.floor((2 * q4 * rc + 4) / 8);
    for (let rc = 1; rc <= 20000; rc += 7) {
      for (let q4 = 1; q4 <= 16; q4++) {
        const quantity = q4 / 4;
        const rate = rc / 100;
        const lines = [{ description: "x", quantity, rate, taxable: true }];
        const amount = draftLineAmount({ quantity, rate });
        expect(Math.round(amount * 100)).toBe(exactCents(q4, rc));
        expect(amount).toBe(serverLineItems(lines)[0].amount);
        expect(computeDraftTotals(lines, { rate: 0.13, name: "HST" })).toEqual(
          serverTotals(lines, { rate: 0.13, name: "HST" }),
        );
      }
    }
  });
});

describe("isIsoCalendarDate matches Cloud Functions", () => {
  it.each(["2026-09-14", "2028-02-29", "2026-02-29", "2026-04-31", "2026-13-01", "2026-9-14", "", "0099-01-01"])(
    "%j",
    (value) => {
      expect(isIsoCalendarDate(value)).toBe(serverIsDate(value));
    },
  );
});

describe("isValidEmail matches Cloud Functions", () => {
  it.each(["jane@example.com", " Jane@Example.COM ", "jane.example.com", "jane@", "@example.com", "a b@c.de", ""])(
    "%j",
    (value) => {
      expect(isValidEmail(value)).toBe(serverIsEmail(value));
    },
  );
});

describe("addDaysIso", () => {
  it("moves by calendar days across month, year and DST boundaries", () => {
    expect(addDaysIso("2026-09-14", 30)).toBe("2026-10-14");
    expect(addDaysIso("2026-12-20", 15)).toBe("2027-01-04");
    expect(addDaysIso("2026-03-01", 14)).toBe("2026-03-15");
    expect(addDaysIso("2028-02-28", 1)).toBe("2028-02-29");
  });
});
