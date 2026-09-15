// verifyInvoicePayToken — Phase 2 Bundle F.
//
// Token-authenticated: NO Firebase auth required. The signed JWT is the auth.
// Returns a discriminated-union VerifyResult so the pay page can branch on
// outcome without catching errors and string-matching (P1 fix from round 4).
//
// Only token-shape failures (invalid signature, expired JWT, missing invoice)
// throw — those are genuine "cannot continue" states. Legitimate render
// states (already paid, regenerated, void, draft) return structured outcomes.
//
// S-09: the payload is what the public pay page shows and nothing more — the
// business as the invoice snapshot recorded it, the invoice's dates, lines and
// totals, the customer's name, and the ways to pay. e-Transfer when the
// snapshot has an e-Transfer email and the invoice is in Canadian dollars
// (Interac e-Transfer moves CAD only); card when the tenant has stripePayments
// and a Stripe account that can take charges, with the amount and fee from
// cardChargeFor — what createPayTokenCheckoutSession charges.

import {
  onCall,
  HttpsError,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { db } from "../shared/admin";
import { isPayableInvoiceStatus } from "../shared/invoiceStatus";
import { cardChargeFor, cardPaymentsReady } from "../shared/payAmounts";
import { verifyPayToken } from "../shared/payToken";
import { loadFeatures } from "../shared/requireFeature";
import { withSentryCallable } from "../shared/withSentry";
import {
  strOrNull,
  toCustomerBusinessView,
  toCustomerLineItems,
  toCustomerTotals,
  type CustomerBusinessView,
  type CustomerLineItemView,
  type CustomerTotalsView,
} from "./customerDocView";

const PAY_TOKEN_SECRET = defineSecret("PAY_TOKEN_SECRET");

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

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
  /** The invoice total in cents: what a card payment charges before any fee. */
  amountDueCents: number;
  /** Null without an e-Transfer email in the snapshot, or outside CAD. */
  etransfer: { email: string } | null;
  /** Null unless the tenant has stripePayments and its account can take charges. */
  card: { feePercent: number; feeCents: number; totalCents: number } | null;
}

export type VerifyResult =
  | { outcome: "ok"; invoice: PayPageInvoice }
  | { outcome: "paid"; paidAt: number; invoiceNumber: string; business: CustomerBusinessView }
  | { outcome: "refunded"; refundedAt: number; invoiceNumber: string; business: CustomerBusinessView }
  | { outcome: "void"; invoiceNumber: string; business: CustomerBusinessView }
  | { outcome: "regenerated" }
  | { outcome: "not-available" };

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
  const business = toCustomerBusinessView(invoice.tenantSnapshot);

  // Structured-status branching — these are legitimate states the pay page
  // must render, not errors.
  if (invoice.deletedAt) return { outcome: "not-available" };

  // A-12: checked before the version so an older link to a voided invoice says
  // "void" rather than pointing the customer at a newer link.
  if (invoice.status === "void") {
    return { outcome: "void", invoiceNumber: snap.id, business };
  }

  if (invoice.payTokenVersion !== payload.v) return { outcome: "regenerated" };

  if (
    invoice.status === "refunded" ||
    invoice.status === "partially-refunded"
  ) {
    return {
      outcome: "refunded",
      refundedAt: invoice.refundedAt?.toMillis?.() ?? 0,
      invoiceNumber: snap.id,
      business,
    };
  }

  if (invoice.status === "paid") {
    return {
      outcome: "paid",
      paidAt: invoice.paidAt?.toMillis?.() ?? 0,
      invoiceNumber: snap.id,
      business,
    };
  }

  // Draft or any other non-payable status must NOT be payable even if a tenant
  // accidentally shared the pay link.
  if (!isPayableInvoiceStatus(invoice.status)) {
    return { outcome: "not-available" };
  }

  const [features, metaSnap] = await Promise.all([
    loadFeatures(payload.tenantId),
    db.doc(`tenants/${payload.tenantId}/meta/settings`).get(),
  ]);
  // Same amounts and D3 kill switch as createPayTokenCheckoutSession, so the
  // fee shown is exactly the fee charged.
  const charge = cardChargeFor(invoice, features.cardSurcharge);
  const etransferEmail =
    business.currency.toUpperCase() === "CAD"
      ? strOrNull(invoice.tenantSnapshot?.etransferEmail)
      : null;
  const cardReady = features.stripePayments && cardPaymentsReady(metaSnap.data());

  return {
    outcome: "ok",
    invoice: {
      invoiceId: payload.invoiceId,
      tenantId: payload.tenantId,
      invoiceNumber: snap.id,
      status: invoice.status,
      issueDate: typeof invoice.issueDate === "string" ? invoice.issueDate : "",
      dueDate: typeof invoice.dueDate === "string" ? invoice.dueDate : "",
      customerName: typeof invoice.customer?.name === "string" ? invoice.customer.name : "",
      lineItems: toCustomerLineItems(invoice.lineItems),
      totals: toCustomerTotals(invoice.totals),
      business: {
        ...business,
        emailFooter: strOrNull(invoice.tenantSnapshot?.emailFooter),
      },
      amountDueCents: charge.baseCents,
      etransfer: etransferEmail ? { email: etransferEmail } : null,
      card: cardReady
        ? {
            feePercent: charge.surcharge.percent,
            feeCents: charge.surchargeCents,
            totalCents: charge.totalCents,
          }
        : null,
    },
  };
}

export const verifyInvoicePayToken = onCall(
  { secrets: [PAY_TOKEN_SECRET] },
  withSentryCallable("verifyInvoicePayToken", verifyInvoicePayTokenHandler),
);
