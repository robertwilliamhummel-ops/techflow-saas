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
import { PdfServiceError, proxyToPdfService } from "@/lib/pdf/proxy";

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
    });

    return await proxyToPdfService({
      path: "/render/quote",
      body: loaded.body,
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
