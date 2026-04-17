// getCustomerInvoiceDetail — Phase 2 Bundle F.
//
// Customer-facing: requires email_verified, NO tenantId claim.
// Returns full invoice doc after verifying caller's email matches
// customer.email. Strips raw payToken — customers discover the pay
// URL from the email link or the portal "Pay Now" button, not from
// this callable.

import {
  onCall,
  HttpsError,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db } from "../shared/admin";
import { readClaims, requireVerifiedCustomer } from "../shared/auth";
import { lowerEmail } from "../shared/email";

export async function getCustomerInvoiceDetailHandler(
  request: CallableRequest,
): Promise<Record<string, unknown>> {
  const claims = readClaims(request);
  const { email } = requireVerifiedCustomer(claims);
  const normalizedEmail = lowerEmail(email);

  const { tenantId, invoiceId } = request.data as {
    tenantId?: string;
    invoiceId?: string;
  };
  if (!tenantId || typeof tenantId !== "string") {
    throw new HttpsError("invalid-argument", "tenantId required.");
  }
  if (!invoiceId || typeof invoiceId !== "string") {
    throw new HttpsError("invalid-argument", "invoiceId required.");
  }

  const docRef = db.doc(`tenants/${tenantId}/invoices/${invoiceId}`);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Invoice not found.");
  }

  const data = snap.data()!;

  // Verify caller email matches invoice's customer.email.
  if (lowerEmail(data.customer?.email) !== normalizedEmail) {
    throw new HttpsError("permission-denied", "Not your invoice.");
  }

  // Strip sensitive fields — customer should not see the raw JWT token.
  const { payToken: _pt, ...safe } = data;

  return {
    id: snap.id,
    tenantId,
    ...safe,
  };
}

export const getCustomerInvoiceDetail = onCall(
  getCustomerInvoiceDetailHandler,
);
