// Totals preview for the invoice form (S-03). Cloud Functions recompute totals
// on save and never accept client math; this mirrors computeInvoiceTotals in
// functions/src/shared/invoice.ts so the preview matches what gets saved, and
// a test runs both on the same lines.

import type { DocumentTotals, TaxLine } from "@/lib/schema/tenant";

export interface DraftLine {
  description: string;
  quantity: number;
  rate: number;
  taxable: boolean;
}

// Money math in exact decimals (audit 2026-11-13). Binary floating point keeps
// some exact half-cents just below .5 (0.25 h x $64.10 = $16.025 is stored as
// 16.02499...), so Math.round(n * 100) rounded them down. Each number is taken
// as the decimal it reads as (its shortest round-trip string: what was typed),
// the two are multiplied exactly as integers, and the product is rounded half
// away from zero. A product that was already exact in cents is unchanged.
// A copy of the helpers in functions/src/shared/invoice.ts, pinned to them by
// src/lib/__tests__/invoiceFormMirrors.test.ts.

interface ExactDecimal {
  units: bigint; // value = units / 10^scale
  scale: number;
}

const TEN = BigInt(10);

function exactDecimal(n: number): ExactDecimal {
  const [mantissa, exponent] = String(n).toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  let units = BigInt(whole + fraction);
  let scale = fraction.length - Number(exponent ?? 0);
  if (scale < 0) {
    units *= TEN ** BigInt(-scale);
    scale = 0;
  }
  return { units, scale };
}

/** a x b x 10^decimals, rounded half away from zero to an integer. */
function roundedProduct(a: number, b: number, decimals: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  const x = exactDecimal(a);
  const y = exactDecimal(b);
  const units = x.units * y.units;
  const scale = x.scale + y.scale - decimals;
  if (scale <= 0) return Number(units * TEN ** BigInt(-scale));
  const divisor = TEN ** BigInt(scale);
  const quotient = units / divisor; // truncates toward zero
  const remainder = units % divisor;
  const twice = (remainder < BigInt(0) ? -remainder : remainder) * BigInt(2);
  const away = twice >= divisor ? (units < BigInt(0) ? BigInt(-1) : BigInt(1)) : BigInt(0);
  return Number(quotient + away);
}

/** quantity x rate in whole cents. */
function lineCents(quantity: number, rate: number): number {
  return roundedProduct(quantity, rate, 2);
}

export function draftLineAmount(line: Pick<DraftLine, "quantity" | "rate">): number {
  return lineCents(line.quantity, line.rate) / 100;
}

export function computeDraftTotals(
  lines: readonly DraftLine[],
  tax: { rate: number; name: string },
): DocumentTotals {
  // Whole cents throughout, so sums are exact too.
  let subtotalCents = 0;
  let taxableCents = 0;
  for (const line of lines) {
    const cents = lineCents(line.quantity, line.rate);
    subtotalCents += cents;
    if (line.taxable) taxableCents += cents;
  }
  const subtotal = subtotalCents / 100;
  const taxableSubtotal = taxableCents / 100;

  const rate = Number.isFinite(tax.rate) && tax.rate > 0 ? tax.rate : 0;
  const taxCents =
    rate > 0 && taxableCents > 0 ? roundedProduct(taxableCents, rate, 0) : 0;
  const taxAmount = taxCents / 100;
  const taxes: TaxLine[] =
    taxAmount > 0
      ? [{ name: tax.name || "Tax", rate, taxableAmount: taxableSubtotal, amount: taxAmount }]
      : [];

  return {
    subtotal,
    taxableSubtotal,
    taxRate: taxAmount > 0 ? rate : 0,
    taxAmount,
    taxes,
    total: (subtotalCents + taxCents) / 100,
  };
}
