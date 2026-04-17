// convertQuoteToInvoice — Phase 2 Bundle E.
//
// Blueprint spec (line 1142–1155):
// - Same customer, line items, totals, tax settings from the quote
// - New invoice number from counters/invoice
// - Fresh tenantSnapshot (in case branding changed since quote was created)
// - sourceQuoteId on the new invoice, convertedToInvoiceId on the quote
// - Transactional: quote status update + invoice creation in one shot
// - Feature gate: BOTH quotes AND invoices
// - Pay token generated on the new invoice (same as createInvoice)

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { sign } from "jsonwebtoken";
import { db, FieldValue, Timestamp } from "../shared/admin";
import { readClaims, requireTenant } from "../shared/auth";
import { requireFeature } from "../shared/requireFeature";
import {
  computeInvoiceTotals,
  computeLineItems,
  buildTenantSnapshot,
  inlineLogoOrNull,
  type LineItemInput,
} from "../shared/invoice";

const PAY_TOKEN_SECRET = defineSecret("PAY_TOKEN_SECRET");

export async function convertQuoteToInvoiceHandler(
  request: CallableRequest,
): Promise<{ invoiceId: string; quoteId: string }> {
  const claims = readClaims(request);
  const { uid, tenantId } = requireTenant(claims);

  // Must have BOTH features enabled.
  await requireFeature(tenantId, "quotes");
  await requireFeature(tenantId, "invoices");

  const data = request.data as Record<string, unknown> | undefined;
  const quoteId = String(data?.quoteId ?? "").trim();
  if (!quoteId) {
    throw new HttpsError("invalid-argument", "quoteId required.");
  }

  // Load quote outside transaction (read-only, avoids contention).
  const quoteRef = db.doc(`tenants/${tenantId}/quotes/${quoteId}`);
  const quoteSnap = await quoteRef.get();
  if (!quoteSnap.exists) {
    throw new HttpsError("not-found", "Quote not found.");
  }
  const quote = quoteSnap.data()!;

  if (quote.status === "converted") {
    throw new HttpsError(
      "failed-precondition",
      "Quote has already been converted to an invoice.",
    );
  }

  // Fresh tenantSnapshot (branding may have changed since quote creation).
  const metaSnap = await db.doc(`tenants/${tenantId}/meta/settings`).get();
  if (!metaSnap.exists) {
    throw new Error("Tenant meta not found — corrupt tenant state.");
  }
  const meta = metaSnap.data()!;
  const snapshot = buildTenantSnapshot(meta);
  snapshot.logo = await inlineLogoOrNull(meta.logoUrl as string | null);

  // Recompute totals from quote line items + current meta taxRate.
  const rawLineItems = (quote.lineItems as LineItemInput[]) ?? [];
  const lineItems = computeLineItems(rawLineItems);
  const totals = computeInvoiceTotals(
    rawLineItems,
    Number(meta.taxRate ?? 0),
    quote.applyTax === true,
  );

  const prefix = String(meta.invoicePrefix ?? "INV");
  const issueDate = new Date().toISOString().slice(0, 10);

  // Transactional: invoice counter + invoice create + quote status update.
  const invoiceId = await db.runTransaction(async (tx) => {
    // Re-read quote inside transaction to guard against double-conversion race.
    const freshQuote = await tx.get(quoteRef);
    if (freshQuote.data()?.status === "converted") {
      throw new HttpsError(
        "failed-precondition",
        "Quote has already been converted to an invoice.",
      );
    }

    // Invoice counter
    const counterRef = db.doc(`tenants/${tenantId}/counters/invoice`);
    const counterSnap = await tx.get(counterRef);
    const current = counterSnap.exists
      ? (counterSnap.data()!.value as number)
      : 0;
    const next = current + 1;
    tx.set(counterRef, {
      value: next,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const id = `${prefix}-${String(next).padStart(4, "0")}`;
    const invoiceRef = db.doc(`tenants/${tenantId}/invoices/${id}`);

    // Pay token for the new invoice.
    const payTokenVersion = 1;
    const payToken = sign(
      { invoiceId: id, tenantId, v: payTokenVersion },
      PAY_TOKEN_SECRET.value(),
      { expiresIn: "60d" },
    );
    const payTokenExpiresAt = Timestamp.fromMillis(
      Date.now() + 60 * 24 * 60 * 60 * 1000,
    );

    // Create invoice with back-reference to source quote.
    tx.set(invoiceRef, {
      customer: quote.customer,
      lineItems,
      applyTax: quote.applyTax === true,
      totals,
      tenantSnapshot: snapshot,
      status: "draft",
      dueDate: quote.validUntil ?? issueDate, // use quote's validUntil as default due date
      issueDate,
      notes: quote.notes ?? null,
      sourceQuoteId: quoteId,
      payToken,
      payTokenExpiresAt,
      payTokenVersion,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: uid,
    });

    // Mark quote as converted with forward-reference to invoice.
    tx.update(quoteRef, {
      status: "converted",
      convertedToInvoiceId: id,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return id;
  });

  return { invoiceId, quoteId };
}

export const convertQuoteToInvoice = onCall(
  { secrets: [PAY_TOKEN_SECRET] },
  convertQuoteToInvoiceHandler,
);
