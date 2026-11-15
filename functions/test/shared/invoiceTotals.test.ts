// Money rounding (audit 2026-11-13): exact half-cents round up, including the
// ones binary floating point stores just below .5.

import { describe, expect, it } from "vitest";
import { computeInvoiceTotals, computeLineItems } from "../../src/shared/invoice";

const line = (quantity: number, rate: number, taxable = true) => ({
  description: "x",
  quantity,
  rate,
  taxable,
});

describe("line amounts", () => {
  it.each([
    // quantity, rate, exact product, saved amount
    [0.25, 64.1, "16.025", 16.03],
    [1.5, 0.69, "1.035", 1.04],
    [0.75, 0.3, "0.225", 0.23],
    [3, 0.335, "1.005", 1.01],
    [1.25, 89.99, "112.4875", 112.49],
    [0.1, 0.05, "0.005", 0.01],
  ])("%s x %s = %s saves %s", (quantity, rate, _exact, amount) => {
    expect(computeLineItems([line(quantity, rate)])[0].amount).toBe(amount);
    expect(computeInvoiceTotals([line(quantity, rate)], { rate: 0, name: "" }).total).toBe(amount);
  });

  it("whole-number quantities at cent rates are unchanged", () => {
    expect(computeLineItems([line(2, 150), line(1, 85), line(7, 19.99)]).map((l) => l.amount)).toEqual([
      300, 85, 139.93,
    ]);
  });

  it("reads numbers in exponent form, and keeps NaN for bad stored data", () => {
    expect(computeLineItems([line(1e-7, 1e7)])[0].amount).toBe(1);
    expect(computeLineItems([line(1.5e-7, 1e5)])[0].amount).toBe(0.02);
    expect(computeLineItems([line(Number.NaN, 1)])[0].amount).toBeNaN();
  });
});

describe("tax", () => {
  it("rounds an exact half-cent of tax up (5% of $0.70 is $0.035)", () => {
    const totals = computeInvoiceTotals([line(1, 0.7)], { rate: 0.05, name: "GST" });
    expect(totals.taxAmount).toBe(0.04);
    expect(totals.total).toBe(0.74);
  });

  it("HST on whole-number lines is unchanged", () => {
    const totals = computeInvoiceTotals([line(1, 5000), line(10, 45)], { rate: 0.13, name: "HST" });
    expect(totals).toEqual({
      subtotal: 5450,
      taxableSubtotal: 5450,
      taxRate: 0.13,
      taxAmount: 708.5,
      taxes: [{ name: "HST", rate: 0.13, taxableAmount: 5450, amount: 708.5 }],
      total: 6158.5,
    });
  });

  it("taxes the cent-rounded taxable lines only, and sums exactly", () => {
    const totals = computeInvoiceTotals(
      [line(0.25, 64.1), line(0.1, 0.2), line(1, 50, false)],
      { rate: 0.13, name: "HST" },
    );
    // 16.03 + 0.02 = 16.05 taxable; 13% = 2.0865 -> 2.09
    expect(totals.taxableSubtotal).toBe(16.05);
    expect(totals.subtotal).toBe(66.05);
    expect(totals.taxAmount).toBe(2.09);
    expect(totals.total).toBe(68.14);
  });
});
