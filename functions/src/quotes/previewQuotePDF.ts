// previewQuotePDF — Phase 6 Bundle D.
//
// Mirrors previewInvoicePDF for quotes (no payment block, no QR code, no
// payToken). Loads the quote's frozen tenantSnapshot and forwards to the
// Cloud Run pdf-service. Returns base64-encoded PDF for in-browser preview.

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

export interface PreviewQuotePDFInput {
  quoteId?: string;
}

export interface PreviewQuotePDFResult {
  pdfBase64: string;
  contentType: string;
  filename: string;
}

export async function previewQuotePDFHandler(
  request: CallableRequest<PreviewQuotePDFInput>,
): Promise<PreviewQuotePDFResult> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  await requireFeature(tenantId, "quotes");

  const quoteId = request.data?.quoteId;
  if (!quoteId || typeof quoteId !== "string") {
    throw new HttpsError("invalid-argument", "quoteId required.");
  }

  const snap = await db.doc(`tenants/${tenantId}/quotes/${quoteId}`).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Quote not found.");
  }
  const quote = snap.data() as Record<string, unknown>;

  const snapshot = quote.tenantSnapshot as Record<string, unknown> | undefined;
  if (!snapshot) {
    throw new HttpsError(
      "failed-precondition",
      "Quote is missing tenantSnapshot.",
    );
  }

  const customer = (quote.customer as Record<string, unknown> | undefined) ?? {};

  const data: Record<string, unknown> = {
    quoteId,
    issueDate: String(quote.issueDate ?? ""),
    validUntil: String(quote.validUntil ?? ""),
    status: String(quote.status ?? "draft"),
    customer: {
      name: String(customer.name ?? ""),
      email: String(customer.email ?? ""),
      phone: typeof customer.phone === "string" ? customer.phone : null,
    },
    lineItems: (quote.lineItems as unknown[]) ?? [],
    totals: (quote.totals as Record<string, unknown>) ?? {},
    notes:
      typeof quote.notes === "string" || quote.notes === null
        ? quote.notes
        : null,
  };

  const result = await renderViaPdfService({
    path: "/render/quote",
    body: { snapshot, data },
    apiKey: PDF_SERVICE_API_KEY.value(),
  });

  return {
    pdfBase64: result.pdfBase64,
    contentType: result.contentType,
    filename: `${quoteId}.pdf`,
  };
}

export const previewQuotePDF = onCall(
  { secrets: [PDF_SERVICE_API_KEY] },
  previewQuotePDFHandler,
);
