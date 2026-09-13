// voidInvoice — A-12.
//
// Owner/admin. Cancels an issued invoice without deleting it: the record and
// its number stay (the CRA expects sales invoices kept for six years, and a
// deleted number leaves an unexplained gap), and the pay link stops working —
// verify and checkout only accept payable statuses, and the Stripe webhook
// refunds a checkout that completes on a void invoice. Final, like Stripe's
// void. Drafts are deleted instead; an invoice with a recorded payment has to
// be refunded, not voided.

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requireRole, requireTenant } from "../shared/auth";
import { requireDocId } from "../shared/docId";
import { isVoidableInvoiceStatus } from "../shared/invoiceStatus";
import { requireFeature } from "../shared/requireFeature";

export async function voidInvoiceHandler(
  request: CallableRequest,
): Promise<{ invoiceId: string; status: "void"; changed: boolean }> {
  const claims = readClaims(request);
  const { uid, tenantId } = requireTenant(claims);
  requireRole(claims, ["owner", "admin"]);
  await requireFeature(tenantId, "invoices");

  const data = request.data as Record<string, unknown> | undefined;
  const invoiceId = requireDocId(data?.invoiceId, "invoiceId");
  const reason =
    data?.reason != null ? String(data.reason).trim() || null : null;
  if (reason && reason.length > 500) {
    throw new HttpsError(
      "invalid-argument",
      "reason must be ≤500 characters.",
    );
  }

  const invoiceRef = db.doc(`tenants/${tenantId}/invoices/${invoiceId}`);

  // Transaction: a payment recorded between the check and the write must not
  // be voided over.
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(invoiceRef);
    if (!snap.exists) {
      throw new HttpsError("not-found", "Invoice not found.");
    }

    const status = String(snap.data()!.status ?? "");
    if (status === "void") {
      return { invoiceId, status: "void" as const, changed: false };
    }
    if (status === "draft") {
      throw new HttpsError(
        "failed-precondition",
        "Drafts can't be voided — delete the draft instead.",
      );
    }
    if (!isVoidableInvoiceStatus(status)) {
      throw new HttpsError(
        "failed-precondition",
        `An invoice with a recorded payment (${status || "unknown"}) can't be voided.`,
      );
    }

    tx.update(invoiceRef, {
      status: "void",
      voidedAt: FieldValue.serverTimestamp(),
      voidedBy: uid,
      voidReason: reason,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { invoiceId, status: "void" as const, changed: true };
  });
}

export const voidInvoice = onCall(voidInvoiceHandler);
