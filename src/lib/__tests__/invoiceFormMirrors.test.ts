// The invoice form previews totals and pre-checks dates and emails with client
// copies of Cloud Functions logic. These tests run both copies on the same
// inputs, so a change to one without the other fails here.

import { describe, expect, it } from "vitest";
import { computeInvoiceTotals as serverTotals } from "../../../functions/src/shared/invoice";
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
