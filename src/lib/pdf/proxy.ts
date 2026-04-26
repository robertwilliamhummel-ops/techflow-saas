// Posts a render request to the Cloud Run pdf-service and proxies the binary
// response back. Sets the X-Api-Key header. The proxy is the only thing that
// holds PDF_SERVICE_API_KEY — the browser never sees it.

export interface PdfProxyOptions {
  path: "/render/invoice" | "/render/quote";
  body: unknown;
  filename: string;
}

export class PdfServiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PdfServiceError";
    this.status = status;
  }
}

export async function proxyToPdfService(
  opts: PdfProxyOptions,
): Promise<Response> {
  const baseUrl = process.env.PDF_SERVICE_URL;
  const apiKey = process.env.PDF_SERVICE_API_KEY;
  if (!baseUrl) {
    throw new PdfServiceError(500, "PDF_SERVICE_URL is not configured.");
  }
  if (!apiKey) {
    throw new PdfServiceError(500, "PDF_SERVICE_API_KEY is not configured.");
  }

  const url = `${baseUrl.replace(/\/+$/, "")}${opts.path}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(opts.body),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "fetch failed";
    throw new PdfServiceError(502, `pdf-service unreachable: ${reason}`);
  }

  if (!upstream.ok) {
    // Upstream errors are propagated as 502 with the body for debugging.
    // We never echo upstream auth headers — only the JSON error message.
    const text = await upstream.text().catch(() => "");
    throw new PdfServiceError(
      upstream.status === 401 || upstream.status === 502 ? 502 : upstream.status,
      `pdf-service returned ${upstream.status}: ${text.slice(0, 500)}`,
    );
  }

  // Stream the PDF body back. Re-set headers explicitly — don't leak upstream
  // server tokens, x-cloud-trace-context, etc.
  const buffer = await upstream.arrayBuffer();
  return new Response(buffer, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${sanitizeFilename(
        opts.filename,
      )}"`,
      "cache-control": "private, no-store",
    },
  });
}

function sanitizeFilename(name: string): string {
  // Strip anything that could break the Content-Disposition header.
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}
