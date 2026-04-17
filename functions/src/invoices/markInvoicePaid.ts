// markInvoicePaid — Phase 2 Bundle D.
//
// Manual fallback for payments outside Stripe (cash, e-transfer).
// Owner/admin only. Separate code path from the Stripe webhook — intentionally.
//
// On transition to paid the pay token is implicitly invalidated: the verify
// path checks `status !== 'paid'` before accepting a checkout attempt.
// No need to rotate the token itself (blueprint Phase 2).

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requireTenant, requireRole } from "../shared/auth";
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
  const invoiceId = String(data?.invoiceId ?? "").trim();
  if (!invoiceId) {
    throw new HttpsError("invalid-argument", "invoiceId required.");
  }

  const method = String(data?.paymentMethod ?? "manual");
  if (!ALLOWED_METHODS.includes(method as ManualPaymentMethod)) {
    throw new HttpsError(
      "invalid-argument",
      `paymentMethod must be one of: ${ALLOWED_METHODS.join(", ")}.`,
    );
  }

  const invoiceRef = db.doc(
    `tenants/${tenantId}/invoices/${invoiceId}`,
  );
  const snap = await invoiceRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Invoice not found.");
  }

  const current = snap.data()!;
  if (current.status === "paid") {
    throw new HttpsError(
      "failed-precondition",
      "Invoice is already marked as paid.",
    );
  }
  if (current.status === "draft") {
    throw new HttpsError(
      "failed-precondition",
      "Cannot mark a draft invoice as paid — send it first.",
    );
  }

  await invoiceRef.update({
    status: "paid",
    paidAt: FieldValue.serverTimestamp(),
    paymentMethod: method,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { invoiceId, status: "paid" };
}

export const markInvoicePaid = onCall(markInvoicePaidHandler);
