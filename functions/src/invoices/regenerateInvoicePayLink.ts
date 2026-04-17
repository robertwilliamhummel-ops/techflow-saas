// regenerateInvoicePayLink — Phase 2 Bundle F.
//
// Tenant callable (owner/admin only). Increments payTokenVersion, signs a new
// JWT, overwrites payToken + payTokenExpiresAt. Invalidates any prior tokens
// for the same invoice. The webhook detects version mismatches and auto-refunds
// (C2 guard — see Phase 4 spec).

import {
  onCall,
  HttpsError,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { db, Timestamp } from "../shared/admin";
import { readClaims, requireTenant, requireRole } from "../shared/auth";
import { requireFeature } from "../shared/requireFeature";
import { signPayToken } from "../shared/payToken";

const PAY_TOKEN_SECRET = defineSecret("PAY_TOKEN_SECRET");

export async function regenerateInvoicePayLinkHandler(
  request: CallableRequest,
): Promise<{ payToken: string; payTokenExpiresAt: number }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  requireRole(claims, ["owner", "admin"]);
  await requireFeature(tenantId, "invoices");

  const { invoiceId } = (request.data ?? {}) as { invoiceId?: string };
  if (!invoiceId || typeof invoiceId !== "string") {
    throw new HttpsError("invalid-argument", "invoiceId required.");
  }

  const invoiceRef = db.doc(`tenants/${tenantId}/invoices/${invoiceId}`);
  const snap = await invoiceRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Invoice not found.");
  }

  const data = snap.data()!;
  const newVersion = (data.payTokenVersion ?? 0) + 1;
  const expiresAtMs = Date.now() + 60 * 24 * 60 * 60 * 1000; // 60 days

  const payToken = signPayToken(
    { invoiceId, tenantId, v: newVersion },
    PAY_TOKEN_SECRET.value(),
  );

  await invoiceRef.update({
    payToken,
    payTokenVersion: newVersion,
    payTokenExpiresAt: Timestamp.fromMillis(expiresAtMs),
  });

  return { payToken, payTokenExpiresAt: expiresAtMs };
}

export const regenerateInvoicePayLink = onCall(
  { secrets: [PAY_TOKEN_SECRET] },
  regenerateInvoicePayLinkHandler,
);
