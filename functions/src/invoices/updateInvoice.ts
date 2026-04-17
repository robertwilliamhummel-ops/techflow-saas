// updateInvoice — Phase 2 Bundle D.
//
// Accepts only mutable fields (line items, customer details, tax flag, dates,
// notes). NEVER tenantSnapshot, createdAt, createdBy, or computed totals.
// Server recomputes totals on every update. If customer email changes,
// lowercase it again (C2 fix).

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requireTenant } from "../shared/auth";
import { requireFeature } from "../shared/requireFeature";
import { lowerEmail } from "../shared/email";
import {
  validateInvoiceInput,
  computeInvoiceTotals,
  computeLineItems,
} from "../shared/invoice";

export async function updateInvoiceHandler(
  request: CallableRequest,
): Promise<{ invoiceId: string }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  await requireFeature(tenantId, "invoices");

  const data = request.data as Record<string, unknown> | undefined;
  const invoiceId = String(data?.invoiceId ?? "").trim();
  if (!invoiceId) {
    throw new HttpsError("invalid-argument", "invoiceId required.");
  }

  const input = validateInvoiceInput(data);
  const customerEmail = lowerEmail(input.customer.email);

  // Read existing invoice to get the frozen tenantSnapshot's taxRate.
  const invoiceRef = db.doc(
    `tenants/${tenantId}/invoices/${invoiceId}`,
  );
  const existing = await invoiceRef.get();
  if (!existing.exists) {
    throw new HttpsError("not-found", "Invoice not found.");
  }

  const doc = existing.data()!;

  // Cannot update paid/refunded invoices.
  const immutableStatuses = ["paid", "refunded", "partially-refunded"];
  if (immutableStatuses.includes(doc.status as string)) {
    throw new HttpsError(
      "failed-precondition",
      `Cannot update an invoice with status '${doc.status}'.`,
    );
  }

  // Recompute totals using the FROZEN snapshot's taxRate — not current meta.
  // The snapshot is the tax rate that was in effect when the invoice was created.
  const snapshotTaxRate = Number(
    (doc.tenantSnapshot as Record<string, unknown>)?.taxRate ?? 0,
  );
  const lineItems = computeLineItems(input.lineItems);
  const totals = computeInvoiceTotals(
    input.lineItems,
    snapshotTaxRate,
    input.applyTax,
  );

  await invoiceRef.update({
    customer: {
      name: input.customer.name,
      email: customerEmail,
      phone: input.customer.phone ?? null,
    },
    lineItems,
    applyTax: input.applyTax,
    totals,
    dueDate: input.dueDate,
    issueDate: input.issueDate ?? doc.issueDate,
    notes: input.notes ?? null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { invoiceId };
}

export const updateInvoice = onCall(updateInvoiceHandler);
