// Proxy: GET /api/pdf/invoice?tenantId=...&invoiceId=...
//
// Verifies the Firebase ID token, runs the dual-auth check, loads the invoice
// from Firestore, and forwards { snapshot, data } to the Cloud Run pdf-service.
// Streams the PDF response back. The X-Api-Key never leaves the server.

import { NextResponse } from "next/server";
import {
  PdfAuthError,
  authorizePdfAccess,
  readBearerToken,
  verifyIdToken,
} from "@/lib/pdf/auth";
import { PdfLoadError, loadInvoiceForPdf } from "@/lib/pdf/loadDoc";
import { PdfServiceError, proxyToPdfService } from "@/lib/pdf/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const tenantId = url.searchParams.get("tenantId");
    const invoiceId = url.searchParams.get("invoiceId");
    if (!tenantId || !invoiceId) {
      return NextResponse.json(
        { error: "tenantId and invoiceId query params are required." },
        { status: 400 },
      );
    }

    const token = readBearerToken(req);
    const decoded = await verifyIdToken(token);

    const platformBaseUrl =
      process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const loaded = await loadInvoiceForPdf(tenantId, invoiceId, platformBaseUrl);

    authorizePdfAccess(decoded, {
      tenantId,
      customerEmail: loaded.customerEmail,
    });

    return await proxyToPdfService({
      path: "/render/invoice",
      body: loaded.body,
      filename: `${invoiceId}.pdf`,
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
  console.error("[/api/pdf/invoice] unexpected error", err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}
