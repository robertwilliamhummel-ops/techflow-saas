// deleteQuote — Phase 2 Bundle E.
//
// Hard delete for MVP. Owner/admin role required.
// Cannot delete a converted quote (it's linked to an invoice).

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db } from "../shared/admin";
import { readClaims, requireTenant, requireRole } from "../shared/auth";
import { requireFeature } from "../shared/requireFeature";

export async function deleteQuoteHandler(
  request: CallableRequest,
): Promise<{ deleted: boolean }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  requireRole(claims, ["owner", "admin"]);
  await requireFeature(tenantId, "quotes");

  const data = request.data as Record<string, unknown> | undefined;
  const quoteId = String(data?.quoteId ?? "").trim();
  if (!quoteId) {
    throw new HttpsError("invalid-argument", "quoteId required.");
  }

  const quoteRef = db.doc(`tenants/${tenantId}/quotes/${quoteId}`);
  const snap = await quoteRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Quote not found.");
  }

  if (snap.data()!.status === "converted") {
    throw new HttpsError(
      "failed-precondition",
      "Cannot delete a converted quote — it is linked to an invoice.",
    );
  }

  await quoteRef.delete();

  return { deleted: true };
}

export const deleteQuote = onCall(deleteQuoteHandler);
