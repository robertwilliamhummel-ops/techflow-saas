// markInvoicePaid — Phase 2 Bundle D.
//
// Manual fallback for payments outside Stripe (cash, e-transfer).
// Owner/admin only. Separate code path from the Stripe webhook — intentionally.
//
// On transition to paid the pay token is implicitly invalidated: verify and
// checkout only accept payable statuses. No need to rotate the token itself
// (blueprint Phase 2).
//
// A-12: only payable statuses can be marked paid (a void or refunded invoice
// used to be accepted), checked in the same transaction as the write.

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requireTenant, requireRole } from "../shared/auth";
import { requireDocId } from "../shared/docId";
import { isPayableInvoiceStatus } from "../shared/invoiceStatus";
import { withSentryCallable } from "../shared/withSentry";
import { requireFeature } from "../shared/requireFeature";
import type { ManualPaymentMethod } from "../shared/invoice";

const ALLOWED_METHODS: readonly ManualPaymentMethod[] = [
  "manual",
  "etransfer",
  "cash",
];

export async function markInvoicePaidHandler(
  request: CallableRequest,
): Promise<{ invoiceId: string; status: string }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  requireRole(claims, ["owner", "admin"]);
  await requireFeature(tenantId, "invoices");

  const data = request.data as Record<string, unknown> | undefined;
  const invoiceId = requireDocId(data?.invoiceId, "invoiceId");

  const method = String(data?.paymentMethod ?? "manual");
  if (!ALLOWED_METHODS.includes(method as ManualPaymentMethod)) {
    throw new HttpsError(
      "invalid-argument",
      `paymentMethod must be one of: ${ALLOWED_METHODS.join(", ")}.`,
    );
  }
  // E-01: onInvoicePaid emails the customer a receipt only when asked.
  const receiptRequested = data?.sendReceipt === true;

  const invoiceRef = db.doc(
    `tenants/${tenantId}/invoices/${invoiceId}`,
  );

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(invoiceRef);
    if (!snap.exists) {
      throw new HttpsError("not-found", "Invoice not found.");
    }

    const status = String(snap.data()!.status ?? "");
    if (status === "paid") {
      throw new HttpsError(
        "failed-precondition",
        "Invoice is already marked as paid.",
      );
    }
    if (status === "draft") {
      throw new HttpsError(
        "failed-precondition",
        "Cannot mark a draft invoice as paid — send it first.",
      );
    }
    if (!isPayableInvoiceStatus(status)) {
      throw new HttpsError(
        "failed-precondition",
        `Cannot mark a ${status || "unknown"} invoice as paid.`,
      );
    }

    tx.update(invoiceRef, {
      status: "paid",
      paidAt: FieldValue.serverTimestamp(),
      paymentMethod: method,
      receiptRequested,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { invoiceId, status: "paid" };
}

export const markInvoicePaid = onCall(
  withSentryCallable("markInvoicePaid", markInvoicePaidHandler),
);
