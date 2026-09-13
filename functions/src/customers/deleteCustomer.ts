// deleteCustomer — A-10.
//
// Owner/admin. Hard delete: invoices, quotes, and recurring templates carry
// their own copy of the customer, so no issued document changes or breaks.

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db } from "../shared/admin";
import { readClaims, requireRole, requireTenant } from "../shared/auth";
import { requireDocId } from "../shared/docId";

export async function deleteCustomerHandler(
  request: CallableRequest,
): Promise<{ deleted: boolean }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  requireRole(claims, ["owner", "admin"]);

  const data = request.data as Record<string, unknown> | undefined;
  const customerId = requireDocId(data?.customerId, "customerId");

  const ref = db.doc(`tenants/${tenantId}/customers/${customerId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Customer not found.");
  }

  await ref.delete();
  return { deleted: true };
}

export const deleteCustomer = onCall(deleteCustomerHandler);
