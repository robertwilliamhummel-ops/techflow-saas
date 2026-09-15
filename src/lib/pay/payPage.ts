// Public pay page (S-09): what verifyInvoicePayToken returns
// (functions/src/portal/verifyInvoicePayToken.ts) and how the pages explain
// each result. Pure, so the rules are tested without rendering.

import { formatMoneyCents } from "@/lib/format";
import type {
  CustomerBusinessView,
  CustomerLineItemView,
  CustomerTotalsView,
} from "@/lib/portal/portalDocument";

// The same shapes as the callable's; a type test pins the two together.

export interface PayPageInvoice {
  invoiceId: string;
  tenantId: string;
  invoiceNumber: string;
  status: string;
  issueDate: string;
  dueDate: string;
  customerName: string;
  lineItems: CustomerLineItemView[];
  totals: CustomerTotalsView;
  business: CustomerBusinessView & { emailFooter: string | null };
  amountDueCents: number;
  etransfer: { email: string } | null;
  card: { feePercent: number; feeCents: number; totalCents: number } | null;
}

export type VerifyResult =
  | { outcome: "ok"; invoice: PayPageInvoice }
  | { outcome: "paid"; paidAt: number; invoiceNumber: string; business: CustomerBusinessView }
  | { outcome: "refunded"; refundedAt: number; invoiceNumber: string; business: CustomerBusinessView }
  | { outcome: "void"; invoiceNumber: string; business: CustomerBusinessView }
  | { outcome: "regenerated" }
  | { outcome: "not-available" };

function bareCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code.replace(/^functions\//, "") : "";
}

export type PayLoadError = "invalid-link" | "failed";

/** A link the callable refuses reads as invalid; anything else is worth retrying. */
export function payLoadError(err: unknown): PayLoadError {
  const code = bareCode(err);
  return code === "permission-denied" || code === "not-found" || code === "invalid-argument"
    ? "invalid-link"
    : "failed";
}

export const CHECKOUT_FAILED_MESSAGE = "Card payment couldn't start. Try again in a moment.";

/** Why a card payment couldn't start, in words for the customer. */
export function checkoutErrorMessage(err: unknown): string {
  const code = bareCode(err);
  if (code === "resource-exhausted") {
    return "There have been too many payment attempts on this invoice. Try again later.";
  }
  // These carry createPayTokenCheckoutSession's own explanation: already paid,
  // a replaced link, or a business that can't take cards right now.
  if (
    (code === "failed-precondition" || code === "permission-denied") &&
    err instanceof Error &&
    err.message
  ) {
    return err.message;
  }
  return CHECKOUT_FAILED_MESSAGE;
}

/** The e-Transfer details as plain text, for the clipboard. */
export function etransferCopyText(
  email: string,
  amountCents: number,
  currency: string,
  invoiceNumber: string,
): string {
  return [
    `Send to: ${email}`,
    `Amount: ${formatMoneyCents(amountCents, currency)}`,
    `Message: ${invoiceNumber}`,
  ].join("\n");
}

/** The single e-Transfer most Canadian banks allow (big five, 2026). */
export const TYPICAL_ETRANSFER_LIMIT_CENTS = 300_000;

export function exceedsTypicalEtransferLimit(amountCents: number): boolean {
  return amountCents > TYPICAL_ETRANSFER_LIMIT_CENTS;
}

/** A card fee percentage as the page states it: 2.4% */
export function formatFeePercent(percent: number): string {
  return `${Math.round(percent * 1000) / 1000}%`;
}

/** Past its due date, or stored as overdue; due today is not late. */
export function isPastDueDate(status: string, dueDate: string, today: string): boolean {
  return status === "overdue" || (dueDate !== "" && dueDate < today);
}
