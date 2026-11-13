// previewInvoicePDF — Phase 6 Bundle D.
//
// Tenant callable: loads the saved invoice's frozen tenantSnapshot and forwards
// to the Cloud Run pdf-service. Returns base64-encoded PDF for in-browser
// preview. Does NOT persist anything — pure render. The payload is built by
// shared/documentPdf.ts, the same builder the invoice emails attach (D14).
//
// Auth: requires tenantId claim (read-side feature gate handled separately
// from sendInvoiceEmail; staff/admin/owner can preview any invoice in their
// tenant).

import {
  onCall,
  HttpsError,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db } from "../shared/admin";
import { readClaims, requireTenant } from "../shared/auth";
import { requireDocId } from "../shared/docId";
import { PDF_SERVICE_API_KEY, renderInvoicePdf } from "../shared/documentPdf";
import { requireFeature } from "../shared/requireFeature";
import { RATE_LIMITS, enforceRateLimit } from "../shared/rateLimit";
import { withSentryCallable } from "../shared/withSentry";

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
  const { uid, tenantId } = requireTenant(claims);
  const features = await requireFeature(tenantId, "invoices");
  await enforceRateLimit(uid, RATE_LIMITS.pdfPreview);

  const invoiceId = requireDocId(request.data?.invoiceId, "invoiceId");

  const snap = await db.doc(`tenants/${tenantId}/invoices/${invoiceId}`).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Invoice not found.");
  }
  const invoice = snap.data() as Record<string, unknown>;

  // Meta only matters for the card section (Stripe readiness and the pay
  // link's verified custom domain), so skip the read when it can't show.
  const needsPayLink =
    typeof invoice.payToken === "string" && invoice.status !== "void";
  const meta = needsPayLink
    ? (await db.doc(`tenants/${tenantId}/meta/settings`).get()).data()
    : undefined;

  const result = await renderInvoicePdf({
    tenantId,
    invoiceId,
    invoice,
    features,
    meta,
  });

  return {
    pdfBase64: result.pdfBase64,
    contentType: result.contentType,
    filename: `${invoiceId}.pdf`,
  };
}

export const previewInvoicePDF = onCall(
  { secrets: [PDF_SERVICE_API_KEY] },
  withSentryCallable("previewInvoicePDF", previewInvoicePDFHandler),
);
