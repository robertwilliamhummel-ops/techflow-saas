// previewQuotePDF — Phase 6 Bundle D.
//
// Mirrors previewInvoicePDF for quotes (no payment block, no QR code, no
// payToken). Loads the quote's frozen tenantSnapshot and forwards to the
// Cloud Run pdf-service. Returns base64-encoded PDF for in-browser preview.
// The payload is built by shared/documentPdf.ts, the same builder the quote
// email attaches (D14).

import {
  onCall,
  HttpsError,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db } from "../shared/admin";
import { readClaims, requireTenant } from "../shared/auth";
import { requireDocId } from "../shared/docId";
import { PDF_SERVICE_API_KEY, renderQuotePdf } from "../shared/documentPdf";
import { requireFeature } from "../shared/requireFeature";
import { RATE_LIMITS, enforceRateLimit } from "../shared/rateLimit";
import { withSentryCallable } from "../shared/withSentry";

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
  const { uid, tenantId } = requireTenant(claims);
  await requireFeature(tenantId, "quotes");
  await enforceRateLimit(uid, RATE_LIMITS.pdfPreview);

  const quoteId = requireDocId(request.data?.quoteId, "quoteId");

  const snap = await db.doc(`tenants/${tenantId}/quotes/${quoteId}`).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Quote not found.");
  }
  const quote = snap.data() as Record<string, unknown>;

  const result = await renderQuotePdf({ tenantId, quoteId, quote });

  return {
    pdfBase64: result.pdfBase64,
    contentType: result.contentType,
    filename: `${quoteId}.pdf`,
  };
}

export const previewQuotePDF = onCall(
  { secrets: [PDF_SERVICE_API_KEY] },
  withSentryCallable("previewQuotePDF", previewQuotePDFHandler),
);
