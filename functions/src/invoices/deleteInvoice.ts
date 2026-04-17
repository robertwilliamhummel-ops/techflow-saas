// deleteInvoice — Phase 2 Bundle D.
//
// Hard delete for MVP (soft-delete UI deferred). Owner/admin role required.

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db } from "../shared/admin";
import { readClaims, requireTenant, requireRole } from "../shared/auth";
import { requireFeature } from "../shared/requireFeature";

export async function deleteInvoiceHandler(
  request: CallableRequest,
): Promise<{ deleted: boolean }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  requireRole(claims, ["owner", "admin"]);
  await requireFeature(tenantId, "invoices");

  const data = request.data as Record<string, unknown> | undefined;
  const invoiceId = String(data?.invoiceId ?? "").trim();
  if (!invoiceId) {
    throw new HttpsError("invalid-argument", "invoiceId required.");
  }

  const invoiceRef = db.doc(
    `tenants/${tenantId}/invoices/${invoiceId}`,
  );
  const snap = await invoiceRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Invoice not found.");
  }

  // Prevent deleting paid invoices — these are legal/tax records.
  const status = (snap.data()!.status as string) ?? "";
  if (status === "paid") {
    throw new HttpsError(
      "failed-precondition",
      "Cannot delete a paid invoice. Refund it first if needed.",
    );
  }

  await invoiceRef.delete();

  return { deleted: true };
}

export const deleteInvoice = onCall(deleteInvoiceHandler);
