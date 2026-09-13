// deleteInvoice — Phase 2 Bundle D; drafts only since A-12.
//
// Owner/admin. Hard-deletes a draft, which was never issued, so no customer
// holds its number. Anything issued is voided instead (voidInvoice) so the
// record stays — the same split Stripe makes between deleting drafts and
// voiding finalized invoices.

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db } from "../shared/admin";
import { readClaims, requireTenant, requireRole } from "../shared/auth";
import { requireDocId } from "../shared/docId";
import { requireFeature } from "../shared/requireFeature";

export async function deleteInvoiceHandler(
  request: CallableRequest,
): Promise<{ deleted: boolean }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  requireRole(claims, ["owner", "admin"]);
  await requireFeature(tenantId, "invoices");

  const data = request.data as Record<string, unknown> | undefined;
  const invoiceId = requireDocId(data?.invoiceId, "invoiceId");

  const invoiceRef = db.doc(
    `tenants/${tenantId}/invoices/${invoiceId}`,
  );

  // Transaction: a draft sent between the check and the delete must survive.
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(invoiceRef);
    if (!snap.exists) {
      throw new HttpsError("not-found", "Invoice not found.");
    }

    const status = String(snap.data()!.status ?? "");
    if (status !== "draft") {
      throw new HttpsError(
        "failed-precondition",
        status === "void"
          ? "This invoice is void and stays on record."
          : `Only drafts can be deleted. Void this ${status || "issued"} invoice instead.`,
      );
    }

    tx.delete(invoiceRef);
  });

  return { deleted: true };
}

export const deleteInvoice = onCall(deleteInvoiceHandler);
