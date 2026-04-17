// createInvoice — Phase 2 Bundle D.
//
// Atomic transaction: counter increment + invoice doc creation + pay token.
// tenantSnapshot frozen at creation time (legal document model).
// Server computes totals — client math is never trusted.

import {
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { sign } from "jsonwebtoken";
import { db, FieldValue, Timestamp } from "../shared/admin";
import { readClaims, requireTenant } from "../shared/auth";
import { requireFeature } from "../shared/requireFeature";
import { lowerEmail } from "../shared/email";
import {
  validateInvoiceInput,
  computeInvoiceTotals,
  computeLineItems,
  buildTenantSnapshot,
  inlineLogoOrNull,
} from "../shared/invoice";

const PAY_TOKEN_SECRET = defineSecret("PAY_TOKEN_SECRET");

export async function createInvoiceHandler(
  request: CallableRequest,
): Promise<{ invoiceId: string }> {
  const claims = readClaims(request);
  const { uid, tenantId } = requireTenant(claims);
  await requireFeature(tenantId, "invoices");

  const input = validateInvoiceInput(request.data);

  // C2 fix — lowercase email at the write boundary, ALWAYS.
  const customerEmail = lowerEmail(input.customer.email);

  // Load tenant meta for snapshot + tax + prefix.
  const metaSnap = await db.doc(`tenants/${tenantId}/meta/settings`).get();
  if (!metaSnap.exists) {
    throw new Error("Tenant meta not found — corrupt tenant state.");
  }
  const meta = metaSnap.data()!;

  // Inline the logo as base64 so the invoice survives future logo changes.
  const snapshot = buildTenantSnapshot(meta);
  snapshot.logo = await inlineLogoOrNull(meta.logoUrl as string | null);

  const lineItems = computeLineItems(input.lineItems);
  const totals = computeInvoiceTotals(
    input.lineItems,
    Number(meta.taxRate ?? 0),
    input.applyTax,
  );

  const prefix = String(meta.invoicePrefix ?? "INV");
  const issueDate =
    input.issueDate ?? new Date().toISOString().slice(0, 10);

  // Atomic: counter increment + invoice create in one transaction.
  const invoiceId = await db.runTransaction(async (tx) => {
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
    const invoiceRef = db.doc(
      `tenants/${tenantId}/invoices/${id}`,
    );

    // Pay token — JWT signed with PAY_TOKEN_SECRET, 60-day expiry.
    const payTokenVersion = 1;
    const payToken = sign(
      { invoiceId: id, tenantId, v: payTokenVersion },
      PAY_TOKEN_SECRET.value(),
      { expiresIn: "60d" },
    );
    const payTokenExpiresAt = Timestamp.fromMillis(
      Date.now() + 60 * 24 * 60 * 60 * 1000,
    );

    tx.set(invoiceRef, {
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
      dueDate: input.dueDate,
      issueDate,
      notes: input.notes ?? null,
      payToken,
      payTokenExpiresAt,
      payTokenVersion,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: uid,
    });

    return id;
  });

  return { invoiceId };
}

export const createInvoice = onCall(
  { secrets: [PAY_TOKEN_SECRET] },
  createInvoiceHandler,
);
