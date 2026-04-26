// Cloud Run pdf-service client for callables.
//
// Mirrors src/lib/pdf/proxy.ts on the Next.js side: the Functions runtime
// also needs to forward { snapshot, data } to the same Cloud Run endpoint,
// authenticating with the X-Api-Key shared secret.
//
// Cloud Run never reads Firestore — the caller hands over a fully-formed
// payload. The X-Api-Key never leaves the server.

import { HttpsError } from "firebase-functions/v2/https";

export interface PdfRenderRequest {
  path: "/render/invoice" | "/render/quote";
  body: { snapshot: Record<string, unknown>; data: Record<string, unknown> };
  apiKey: string;
}

export interface PdfRenderResult {
  pdfBase64: string;
  contentType: string;
}

export async function renderViaPdfService(
  req: PdfRenderRequest,
): Promise<PdfRenderResult> {
  const baseUrl = process.env.PDF_SERVICE_URL;
  if (!baseUrl) {
    throw new HttpsError(
      "failed-precondition",
      "PDF_SERVICE_URL is not configured.",
    );
  }
  if (!req.apiKey) {
    throw new HttpsError(
      "failed-precondition",
      "PDF_SERVICE_API_KEY is not configured.",
    );
  }

  const url = `${baseUrl.replace(/\/+$/, "")}${req.path}`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": req.apiKey,
      },
      body: JSON.stringify(req.body),
    });
  } catch (err) {
    throw new HttpsError(
      "unavailable",
      `pdf-service unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    // Upstream 401 means our X-Api-Key is wrong — that's a server config bug,
    // not a caller bug. Surface as internal so the caller doesn't see "auth".
    if (upstream.status === 401 || upstream.status >= 500) {
      throw new HttpsError(
        "internal",
        `pdf-service error ${upstream.status}: ${text.slice(0, 200)}`,
      );
    }
    // 4xx other than 401 — bad payload from us. Surface verbatim so the cause
    // is debuggable.
    throw new HttpsError(
      "invalid-argument",
      `pdf-service rejected payload (${upstream.status}): ${text.slice(0, 200)}`,
    );
  }

  const contentType = upstream.headers.get("content-type") ?? "application/pdf";
  const buffer = Buffer.from(await upstream.arrayBuffer());
  return {
    pdfBase64: buffer.toString("base64"),
    contentType,
  };
}
