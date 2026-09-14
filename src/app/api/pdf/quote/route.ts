// Proxy: GET /api/pdf/quote?tenantId=...&quoteId=...
// Mirrors /api/pdf/invoice but for quotes (no payment block, no QR).

import { NextResponse } from "next/server";
import {
  PdfAuthError,
  authorizePdfAccess,
  readBearerToken,
  verifyIdToken,
} from "@/lib/pdf/auth";
import { PdfLoadError, loadQuoteForPdf } from "@/lib/pdf/loadDoc";
import { withPdfLogo } from "@/lib/pdf/logo";
import { PdfServiceError, proxyToPdfService } from "@/lib/pdf/proxy";
import { isCustomerVisibleQuoteStatus } from "@/lib/portal/customerVisibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const tenantId = url.searchParams.get("tenantId");
    const quoteId = url.searchParams.get("quoteId");
    if (!tenantId || !quoteId) {
      return NextResponse.json(
        { error: "tenantId and quoteId query params are required." },
        { status: 400 },
      );
    }

    const token = readBearerToken(req);
    const decoded = await verifyIdToken(token);

    const loaded = await loadQuoteForPdf(tenantId, quoteId);

    authorizePdfAccess(decoded, {
      tenantId,
      customerEmail: loaded.customerEmail,
      // S-08: a customer never gets a draft (A-05).
      customerMayView: isCustomerVisibleQuoteStatus(loaded.status),
    });

    return await proxyToPdfService({
      path: "/render/quote",
      // D7 — fetch the logo copy only for a caller allowed to see the quote.
      body: await withPdfLogo(loaded.body, tenantId),
      filename: `${quoteId}.pdf`,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof PdfAuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof PdfLoadError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof PdfServiceError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[/api/pdf/quote] unexpected error", err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}
