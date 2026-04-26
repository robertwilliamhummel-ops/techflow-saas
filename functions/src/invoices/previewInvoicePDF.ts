// previewInvoicePDF — Phase 6 Bundle D.
//
// Tenant callable: loads the saved invoice's frozen tenantSnapshot and forwards
// to the Cloud Run pdf-service. Returns base64-encoded PDF for in-browser
// preview. Does NOT persist anything — pure render.
//
// Auth: requires tenantId claim (read-side feature gate handled separately
// from sendInvoiceEmail; staff/admin/owner can preview any invoice in their
// tenant).

import {
  onCall,
  HttpsError,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { db } from "../shared/admin";
import { readClaims, requireTenant } from "../shared/auth";
import { requireFeature } from "../shared/requireFeature";
import { renderViaPdfService } from "../shared/pdfService";

const PDF_SERVICE_API_KEY = defineSecret("PDF_SERVICE_API_KEY");

export interface PreviewInvoicePDFInput {
  invoiceId?: string;
}

export interface PreviewInvoicePDFResult {
  pdfBase64: string;
  contentType: string;
  filename: string;
}

export async function previewInvoicePDFHandler(
  request: CallableRequest<PreviewInvoicePDFInput>,
): Promise<PreviewInvoicePDFResult> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  await requireFeature(tenantId, "invoices");

  const invoiceId = request.data?.invoiceId;
  if (!invoiceId || typeof invoiceId !== "string") {
    throw new HttpsError("invalid-argument", "invoiceId required.");
  }

  const snap = await db.doc(`tenants/${tenantId}/invoices/${invoiceId}`).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Invoice not found.");
  }
  const invoice = snap.data() as Record<string, unknown>;

  const snapshot = invoice.tenantSnapshot as Record<string, unknown> | undefined;
  if (!snapshot) {
    throw new HttpsError(
      "failed-precondition",
      "Invoice is missing tenantSnapshot.",
    );
  }

  const customer = (invoice.customer as Record<string, unknown> | undefined) ?? {};
  const appUrl =
    process.env.APP_URL ?? "https://portal.techflowsolutions.ca";
  const payToken = typeof invoice.payToken === "string" ? invoice.payToken : null;
  const payUrl = payToken
    ? `${appUrl.replace(/\/+$/, "")}/pay/${payToken}`
    : null;

  const data: Record<string, unknown> = {
    invoiceId,
    issueDate: String(invoice.issueDate ?? ""),
    dueDate: String(invoice.dueDate ?? ""),
    status: String(invoice.status ?? "draft"),
    customer: {
      name: String(customer.name ?? ""),
      email: String(customer.email ?? ""),
      phone: typeof customer.phone === "string" ? customer.phone : null,
    },
    lineItems: (invoice.lineItems as unknown[]) ?? [],
    totals: (invoice.totals as Record<string, unknown>) ?? {},
    notes:
      typeof invoice.notes === "string" || invoice.notes === null
        ? invoice.notes
        : null,
    paidVia:
      typeof invoice.paymentMethod === "string" && invoice.paymentMethod
        ? invoice.paymentMethod
        : null,
    paidAt: serializeTimestamp(invoice.paidAt),
    surchargeAmountCents:
      typeof invoice.surchargeAmountCents === "number"
        ? invoice.surchargeAmountCents
        : null,
    payUrl,
  };

  const result = await renderViaPdfService({
    path: "/render/invoice",
    body: { snapshot, data },
    apiKey: PDF_SERVICE_API_KEY.value(),
  });

  return {
    pdfBase64: result.pdfBase64,
    contentType: result.contentType,
    filename: `${invoiceId}.pdf`,
  };
}

export const previewInvoicePDF = onCall(
  { secrets: [PDF_SERVICE_API_KEY] },
  previewInvoicePDFHandler,
);

function serializeTimestamp(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const maybe = value as { toDate?: () => Date; seconds?: number };
    if (typeof maybe.toDate === "function") {
      return maybe.toDate().toISOString().slice(0, 10);
    }
    if (typeof maybe.seconds === "number") {
      return new Date(maybe.seconds * 1000).toISOString().slice(0, 10);
    }
  }
  return null;
}
