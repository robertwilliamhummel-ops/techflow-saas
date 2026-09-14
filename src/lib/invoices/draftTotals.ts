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

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

export function draftLineAmount(line: Pick<DraftLine, "quantity" | "rate">): number {
  return roundCents(line.quantity * line.rate);
}

export function computeDraftTotals(
  lines: readonly DraftLine[],
  tax: { rate: number; name: string },
): DocumentTotals {
  let subtotal = 0;
  let taxableSubtotal = 0;
  for (const line of lines) {
    const amount = roundCents(line.quantity * line.rate);
    subtotal += amount;
    if (line.taxable) taxableSubtotal += amount;
  }
  subtotal = roundCents(subtotal);
  taxableSubtotal = roundCents(taxableSubtotal);

  const rate = Number.isFinite(tax.rate) && tax.rate > 0 ? tax.rate : 0;
  const taxAmount =
    rate > 0 && taxableSubtotal > 0 ? roundCents(taxableSubtotal * rate) : 0;
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
    total: roundCents(subtotal + taxAmount),
  };
}
