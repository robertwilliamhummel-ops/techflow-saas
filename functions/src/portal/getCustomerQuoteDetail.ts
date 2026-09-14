// getCustomerQuoteDetail — P-06.
//
// Customer-facing: requires email_verified, NO tenantId claim. The quote
// companion to getCustomerInvoiceDetail, for /portal/quotes/[id]: returns the
// customer's view of the quote (customerDocView.ts, S-08) after verifying the
// caller's email matches customer.email. Drafts answer not-found (A-05).

import {
  onCall,
  HttpsError,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db } from "../shared/admin";
import { readClaims, requireVerifiedCustomer } from "../shared/auth";
import { requireDocId } from "../shared/docId";
import { withSentryCallable } from "../shared/withSentry";
import { lowerEmail } from "../shared/email";
import { isCustomerVisibleQuoteStatus } from "../shared/customerVisibility";
import { toCustomerQuoteView, type CustomerQuoteView } from "./customerDocView";

export async function getCustomerQuoteDetailHandler(
  request: CallableRequest,
): Promise<CustomerQuoteView> {
  const claims = readClaims(request);
  const { email } = requireVerifiedCustomer(claims);
  const normalizedEmail = lowerEmail(email);

  const data = request.data as Record<string, unknown> | undefined;
  const tenantId = requireDocId(data?.tenantId, "tenantId");
  const quoteId = requireDocId(data?.quoteId, "quoteId");

  const snap = await db.doc(`tenants/${tenantId}/quotes/${quoteId}`).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Quote not found.");
  }

  const quote = snap.data()!;

  // Verify caller email matches the quote's customer.email.
  if (lowerEmail(quote.customer?.email) !== normalizedEmail) {
    throw new HttpsError("permission-denied", "Not your quote.");
  }

  // A-05 — drafts aren't shown to customers; answer as if it didn't exist.
  if (!isCustomerVisibleQuoteStatus(quote.status)) {
    throw new HttpsError("not-found", "Quote not found.");
  }

  return toCustomerQuoteView(snap.id, tenantId, quote);
}

export const getCustomerQuoteDetail = onCall(
  withSentryCallable("getCustomerQuoteDetail", getCustomerQuoteDetailHandler),
);
