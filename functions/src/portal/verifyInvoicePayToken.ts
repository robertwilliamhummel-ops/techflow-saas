// verifyInvoicePayToken — Phase 2 Bundle F.
//
// Token-authenticated: NO Firebase auth required. The signed JWT is the auth.
// Returns a discriminated-union VerifyResult so the pay page can branch on
// outcome without catching errors and string-matching (P1 fix from round 4).
//
// Only token-shape failures (invalid signature, expired JWT, missing invoice)
// throw — those are genuine "cannot continue" states. Legitimate render
// states (already paid, regenerated, draft) return structured outcomes.

import {
  onCall,
  HttpsError,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { db } from "../shared/admin";
import { verifyPayToken } from "../shared/payToken";

const PAY_TOKEN_SECRET = defineSecret("PAY_TOKEN_SECRET");

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface PayPagePayload {
  invoiceId: string;
  tenantId: string;
  invoiceNumber: string;
  customer: { name: string; email: string };
  lineItems: Array<{
    description: string;
    quantity: number;
    rate: number;
    amount: number;
  }>;
  totals: { subtotal: number; taxRate: number; taxAmount: number; total: number };
  status: string;
  tenantSnapshot: Record<string, unknown>;
  chargeCustomerCardFees: boolean;
  cardFeePercent: number;
  etransferEmail: string | null;
}

export type VerifyResult =
  | { outcome: "ok"; invoice: PayPagePayload }
  | { outcome: "paid"; paidAt: number; invoiceNumber: string }
  | { outcome: "refunded"; refundedAt: number; invoiceNumber: string }
  | { outcome: "regenerated" }
  | { outcome: "not-available" };

// Statuses that are valid payment targets. Draft/archived invoices must NOT
// be payable even if a tenant accidentally shared the pay link.
const PAYABLE_STATUSES = ["sent", "unpaid", "overdue", "partial"] as const;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function verifyInvoicePayTokenHandler(
  request: CallableRequest,
): Promise<VerifyResult> {
  const { token } = (request.data ?? {}) as { token?: string };
  if (!token || typeof token !== "string") {
    throw new HttpsError("invalid-argument", "Token required.");
  }

  let payload: { invoiceId: string; tenantId: string; v: number };
  try {
    payload = verifyPayToken(token, PAY_TOKEN_SECRET.value());
  } catch {
    throw new HttpsError("permission-denied", "Invalid or expired pay link.");
  }

  const invoiceRef = db.doc(
    `tenants/${payload.tenantId}/invoices/${payload.invoiceId}`,
  );
  const snap = await invoiceRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Invoice not found.");
  }

  const invoice = snap.data()!;

  // Structured-status branching — these are legitimate states the pay page
  // must render, not errors.
  if (invoice.deletedAt) return { outcome: "not-available" };

  if (invoice.payTokenVersion !== payload.v) return { outcome: "regenerated" };

  if (
    invoice.status === "refunded" ||
    invoice.status === "partially-refunded"
  ) {
    return {
      outcome: "refunded",
      refundedAt: invoice.refundedAt?.toMillis?.() ?? 0,
      invoiceNumber: snap.id,
    };
  }

  if (invoice.status === "paid") {
    return {
      outcome: "paid",
      paidAt: invoice.paidAt?.toMillis?.() ?? 0,
      invoiceNumber: snap.id,
    };
  }

  if (
    !PAYABLE_STATUSES.includes(invoice.status as (typeof PAYABLE_STATUSES)[number])
  ) {
    return { outcome: "not-available" };
  }

  // Return minimal payload for rendering the public pay page.
  return {
    outcome: "ok",
    invoice: {
      invoiceId: payload.invoiceId,
      tenantId: payload.tenantId,
      invoiceNumber: snap.id,
      customer: {
        name: invoice.customer?.name ?? "",
        email: invoice.customer?.email ?? "",
      },
      lineItems: invoice.lineItems ?? [],
      totals: invoice.totals ?? {
        subtotal: 0,
        taxRate: 0,
        taxAmount: 0,
        total: 0,
      },
      status: invoice.status,
      tenantSnapshot: invoice.tenantSnapshot ?? {},
      chargeCustomerCardFees: Boolean(
        invoice.tenantSnapshot?.chargeCustomerCardFees,
      ),
      cardFeePercent: invoice.tenantSnapshot?.cardFeePercent ?? 0,
      etransferEmail: invoice.tenantSnapshot?.etransferEmail ?? null,
    },
  };
}

export const verifyInvoicePayToken = onCall(
  { secrets: [PAY_TOKEN_SECRET] },
  verifyInvoicePayTokenHandler,
);
