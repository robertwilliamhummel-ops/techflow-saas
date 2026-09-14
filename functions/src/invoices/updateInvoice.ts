// updateInvoice — Phase 2 Bundle D.
//
// Accepts only mutable fields (line items, customer details, tax flag, dates,
// notes). NEVER tenantSnapshot, createdAt, createdBy, or computed totals.
// Server recomputes totals on every update. If customer email changes,
// lowercase it again (C2 fix).
//
// A-08: once an invoice is sent, its pay link stands for what the customer was
// shown. Changing the total or the customer email re-issues the link
// (payTokenVersion + 1, new JWT), so the emailed link stops working and a
// checkout already open on it is refunded by the webhook's C2 guard. The caller
// sees `payLinkRegenerated` and should resend the invoice.

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { db, FieldValue, Timestamp } from "../shared/admin";
import { readClaims, requireTenant } from "../shared/auth";
import { requireDocId } from "../shared/docId";
import { requireFeature } from "../shared/requireFeature";
import { lowerEmail } from "../shared/email";
import { signPayToken } from "../shared/payToken";
import { withSentryCallable } from "../shared/withSentry";
import {
  validateInvoiceInput,
  computeInvoiceTotals,
  computeLineItems,
} from "../shared/invoice";

const PAY_TOKEN_SECRET = defineSecret("PAY_TOKEN_SECRET");

// Same lifetime createInvoice and regenerateInvoicePayLink give a pay link.
const PAY_LINK_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export async function updateInvoiceHandler(
  request: CallableRequest,
): Promise<{ invoiceId: string; payLinkRegenerated: boolean }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  await requireFeature(tenantId, "invoices");

  const data = request.data as Record<string, unknown> | undefined;
  const invoiceId = requireDocId(data?.invoiceId, "invoiceId");

  const input = validateInvoiceInput(data);
  const customerEmail = lowerEmail(input.customer.email);

  const invoiceRef = db.doc(
    `tenants/${tenantId}/invoices/${invoiceId}`,
  );

  // Transaction: the status check and the write must see the same invoice, so
  // a payment recorded in between can't be overwritten by a stale edit.
  return await db.runTransaction(async (tx) => {
    const existing = await tx.get(invoiceRef);
    if (!existing.exists) {
      throw new HttpsError("not-found", "Invoice not found.");
    }

    const doc = existing.data()!;

    // Cannot update paid/refunded invoices.
    const immutableStatuses = ["paid", "refunded", "partially-refunded", "void"];
    if (immutableStatuses.includes(doc.status as string)) {
      throw new HttpsError(
        "failed-precondition",
        `Cannot update an invoice with status '${doc.status}'.`,
      );
    }

    // Recompute totals using the FROZEN snapshot's tax — not current meta.
    // The snapshot is the tax that was in effect when the invoice was created.
    const snapshot = (doc.tenantSnapshot as Record<string, unknown>) ?? {};
    const lineItems = computeLineItems(input.lineItems);
    const totals = computeInvoiceTotals(input.lineItems, {
      rate: Number(snapshot.taxRate ?? 0),
      name: String(snapshot.taxName ?? ""),
    });

    const update: Record<string, unknown> = {
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
    };

    const previousTotalCents = Math.round(Number(doc.totals?.total ?? 0) * 100);
    const payLinkRegenerated =
      doc.status !== "draft" &&
      (Math.round(totals.total * 100) !== previousTotalCents ||
        customerEmail !== doc.customer?.email);

    if (payLinkRegenerated) {
      const payTokenVersion = Number(doc.payTokenVersion ?? 0) + 1;
      update.payTokenVersion = payTokenVersion;
      update.payToken = signPayToken(
        { invoiceId, tenantId, v: payTokenVersion },
        PAY_TOKEN_SECRET.value(),
      );
      update.payTokenExpiresAt = Timestamp.fromMillis(
        Date.now() + PAY_LINK_TTL_MS,
      );
    }

    tx.update(invoiceRef, update);
    return { invoiceId, payLinkRegenerated };
  });
}

export const updateInvoice = onCall(
  { secrets: [PAY_TOKEN_SECRET] },
  withSentryCallable("updateInvoice", updateInvoiceHandler),
);
