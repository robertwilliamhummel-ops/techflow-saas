// updateQuote — Phase 2 Bundle E.
//
// Mirrors updateInvoice: mutable fields only, recomputes totals from
// frozen snapshot taxRate. Cannot update converted quotes.

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requireTenant } from "../shared/auth";
import { requireDocId } from "../shared/docId";
import { requireFeature } from "../shared/requireFeature";
import { lowerEmail } from "../shared/email";
import { computeInvoiceTotals, computeLineItems } from "../shared/invoice";
import { validateQuoteInput } from "../shared/quote";
import { withSentryCallable } from "../shared/withSentry";

export async function updateQuoteHandler(
  request: CallableRequest,
): Promise<{ quoteId: string }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  await requireFeature(tenantId, "quotes");

  const data = request.data as Record<string, unknown> | undefined;
  const quoteId = requireDocId(data?.quoteId, "quoteId");

  const input = validateQuoteInput(data);
  const customerEmail = lowerEmail(input.customer.email);

  const quoteRef = db.doc(`tenants/${tenantId}/quotes/${quoteId}`);
  const existing = await quoteRef.get();
  if (!existing.exists) {
    throw new HttpsError("not-found", "Quote not found.");
  }

  const doc = existing.data()!;

  // Cannot update converted quotes.
  if (doc.status === "converted") {
    throw new HttpsError(
      "failed-precondition",
      "Cannot update a converted quote.",
    );
  }

  // Recompute totals using the FROZEN snapshot's tax.
  const snapshot = (doc.tenantSnapshot as Record<string, unknown>) ?? {};
  const lineItems = computeLineItems(input.lineItems);
  const totals = computeInvoiceTotals(input.lineItems, {
    rate: Number(snapshot.taxRate ?? 0),
    name: String(snapshot.taxName ?? ""),
  });

  await quoteRef.update({
    customer: {
      name: input.customer.name,
      email: customerEmail,
      phone: input.customer.phone ?? null,
    },
    lineItems,
    applyTax: input.applyTax,
    totals,
    validUntil: input.validUntil,
    issueDate: input.issueDate ?? doc.issueDate,
    notes: input.notes ?? null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { quoteId };
}

export const updateQuote = onCall(
  withSentryCallable("updateQuote", updateQuoteHandler),
);
