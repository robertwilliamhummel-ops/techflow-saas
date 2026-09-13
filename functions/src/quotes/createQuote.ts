// createQuote — Phase 2 Bundle E.
//
// Mirrors createInvoice: atomic counter + frozen tenantSnapshot.
// No pay token — quotes are not directly payable.

import { onCall, type CallableRequest } from "firebase-functions/v2/https";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requireTenant } from "../shared/auth";
import { requireFeature } from "../shared/requireFeature";
import { lowerEmail } from "../shared/email";
import {
  computeInvoiceTotals,
  computeLineItems,
  buildTenantSnapshot,
} from "../shared/invoice";
import { applyLogoToSnapshot } from "../shared/logo";
import { validateQuoteInput } from "../shared/quote";

// Quotes have their own counter, so they need their own prefix or a quote
// would share its visible number with an invoice (ACME-0001 twice). The
// default INV becomes QT; a custom prefix gets -QT (ACME → ACME-QT-0001).
export function quotePrefixFor(invoicePrefix: unknown): string {
  const prefix = String(invoicePrefix ?? "").trim() || "INV";
  return prefix === "INV" ? "QT" : `${prefix}-QT`;
}

export async function createQuoteHandler(
  request: CallableRequest,
): Promise<{ quoteId: string }> {
  const claims = readClaims(request);
  const { uid, tenantId } = requireTenant(claims);
  const features = await requireFeature(tenantId, "quotes");

  const input = validateQuoteInput(request.data);
  const customerEmail = lowerEmail(input.customer.email);

  // Load tenant meta for snapshot + tax + prefix.
  const metaSnap = await db.doc(`tenants/${tenantId}/meta/settings`).get();
  if (!metaSnap.exists) {
    throw new Error("Tenant meta not found — corrupt tenant state.");
  }
  const meta = metaSnap.data()!;

  // Freeze the logo: base64 for the PDF, immutable https copy for emails (A-06).
  const snapshot = buildTenantSnapshot(meta, features);
  await applyLogoToSnapshot(
    snapshot,
    tenantId,
    (meta.logoUrl as string | null) ?? null,
  );

  const lineItems = computeLineItems(input.lineItems);
  const totals = computeInvoiceTotals(input.lineItems, {
    rate: Number(meta.taxRate ?? 0),
    name: String(meta.taxName ?? ""),
  });

  const prefix = quotePrefixFor(meta.invoicePrefix);
  const issueDate =
    input.issueDate ?? new Date().toISOString().slice(0, 10);

  // Atomic: counter increment + quote create in one transaction.
  const quoteId = await db.runTransaction(async (tx) => {
    const counterRef = db.doc(`tenants/${tenantId}/counters/quote`);
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
    const quoteRef = db.doc(`tenants/${tenantId}/quotes/${id}`);

    tx.set(quoteRef, {
      customer: {
        name: input.customer.name,
        email: customerEmail,
        phone: input.customer.phone ?? null,
      },
      lineItems,
      applyTax: input.applyTax,
      totals,
      tenantSnapshot: snapshot,
      status: "draft",
      validUntil: input.validUntil,
      issueDate,
      notes: input.notes ?? null,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: uid,
    });

    return id;
  });

  return { quoteId };
}

export const createQuote = onCall(createQuoteHandler);
