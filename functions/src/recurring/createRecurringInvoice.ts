// createRecurringInvoice — Phase 2 Bundle G.
//
// Tenant callable: creates a recurring invoice template. The template stores
// customer, line items, and scheduling config. The scheduled processor
// (processRecurringInvoices) uses it to generate real invoices on schedule.
//
// No tenantSnapshot on the template — each generated invoice gets a fresh
// snapshot from current meta at generation time.

import { onCall, type CallableRequest } from "firebase-functions/v2/https";
import { db, FieldValue, Timestamp } from "../shared/admin";
import { readClaims, requireTenant } from "../shared/auth";
import { requireFeature } from "../shared/requireFeature";
import { lowerEmail } from "../shared/email";
import { computeInvoiceTotals, computeLineItems } from "../shared/invoice";
import {
  validateRecurringInvoiceInput,
  extractAnchorDay,
} from "../shared/recurring";

export async function createRecurringInvoiceHandler(
  request: CallableRequest,
): Promise<{ recurringInvoiceId: string }> {
  const claims = readClaims(request);
  const { uid, tenantId } = requireTenant(claims);
  await requireFeature(tenantId, "recurringInvoices");

  const input = validateRecurringInvoiceInput(request.data);

  // C2 fix — lowercase email at the write boundary, ALWAYS.
  const customerEmail = lowerEmail(input.customer.email);

  // Load tenant meta for totals computation (taxRate).
  const metaSnap = await db.doc(`tenants/${tenantId}/meta/settings`).get();
  if (!metaSnap.exists) {
    throw new Error("Tenant meta not found — corrupt tenant state.");
  }
  const meta = metaSnap.data()!;

  // Server-computed line items + totals (preview values — recomputed at
  // generation time from current meta).
  const lineItems = computeLineItems(input.lineItems);
  const totals = computeInvoiceTotals(
    input.lineItems,
    Number(meta.taxRate ?? 0),
    input.applyTax,
  );

  // Derive anchorDay and initial nextRunAt from startDate.
  const anchorDay = extractAnchorDay(input.startDate);
  const nextRunAt = Timestamp.fromDate(
    new Date(input.startDate + "T00:00:00Z"),
  );

  const docRef = db.collection(`tenants/${tenantId}/recurringInvoices`).doc();

  await docRef.set({
    customer: {
      name: input.customer.name,
      email: customerEmail,
      phone: input.customer.phone ?? null,
    },
    lineItems,
    applyTax: input.applyTax,
    totals,
    notes: input.notes ?? null,
    internalDescription: input.internalDescription ?? null,
    daysUntilDue: input.daysUntilDue,

    // Scheduling
    interval: input.interval,
    anchorDay,
    startDate: input.startDate,
    nextRunAt,

    // Completion bounds
    endAfterCount: input.endAfterCount ?? null,
    endDate: input.endDate ?? null,

    // Behavior
    autoSend: input.autoSend,

    // Lifecycle
    status: "active",
    createdAt: FieldValue.serverTimestamp(),
    createdBy: uid,
    updatedAt: null,
    pausedAt: null,
    cancelledAt: null,

    // Run tracking
    generatedCount: 0,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    consecutiveFailures: 0,
    lastGeneratedInvoiceId: null,
  });

  return { recurringInvoiceId: docRef.id };
}

export const createRecurringInvoice = onCall(createRecurringInvoiceHandler);
