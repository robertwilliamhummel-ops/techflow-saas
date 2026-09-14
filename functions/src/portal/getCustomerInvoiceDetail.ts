// getCustomerInvoiceDetail — Phase 2 Bundle F.
//
// Customer-facing: requires email_verified, NO tenantId claim. Returns the
// customer's view of the invoice (customerDocView.ts) after verifying the
// caller's email matches customer.email: no internal fields, Timestamps as
// epoch milliseconds, and the pay token only while the invoice is payable —
// the portal's Pay button opens /pay/{payToken} (S-08).

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
import { toCustomerInvoiceView, type CustomerInvoiceView } from "./customerDocView";

export async function getCustomerInvoiceDetailHandler(
  request: CallableRequest,
): Promise<CustomerInvoiceView> {
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

  return toCustomerInvoiceView(snap.id, tenantId, invoice);
}

export const getCustomerInvoiceDetail = onCall(
  withSentryCallable("getCustomerInvoiceDetail", getCustomerInvoiceDetailHandler),
);
