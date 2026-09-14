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
import { requireDocId } from "../shared/docId";
import { lowerEmail } from "../shared/email";
import { isCustomerVisibleInvoiceStatus } from "../shared/customerVisibility";
import { withSentryCallable } from "../shared/withSentry";

export async function getCustomerInvoiceDetailHandler(
  request: CallableRequest,
): Promise<Record<string, unknown>> {
  const claims = readClaims(request);
  const { email } = requireVerifiedCustomer(claims);
  const normalizedEmail = lowerEmail(email);

  // S-07: both ids become path segments, like every caller-supplied id.
  const data = request.data as Record<string, unknown> | undefined;
  const tenantId = requireDocId(data?.tenantId, "tenantId");
  const invoiceId = requireDocId(data?.invoiceId, "invoiceId");

  const docRef = db.doc(`tenants/${tenantId}/invoices/${invoiceId}`);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Invoice not found.");
  }

  const invoice = snap.data()!;

  // Verify caller email matches invoice's customer.email.
  if (lowerEmail(invoice.customer?.email) !== normalizedEmail) {
    throw new HttpsError("permission-denied", "Not your invoice.");
  }

  // A-05 — drafts aren't shown to customers; answer as if it didn't exist.
  if (!isCustomerVisibleInvoiceStatus(invoice.status)) {
    throw new HttpsError("not-found", "Invoice not found.");
  }

  // Strip sensitive fields — customer should not see the raw JWT token.
  const { payToken: _pt, ...safe } = invoice;

  return {
    id: snap.id,
    tenantId,
    ...safe,
  };
}

export const getCustomerInvoiceDetail = onCall(
  withSentryCallable("getCustomerInvoiceDetail", getCustomerInvoiceDetailHandler),
);
