// Decode the JWT payload WITHOUT signature verification.
// Used only by metadata-loading code paths (favicon, <title>) where we
// just need tenantId to fetch branding. The actual pay page MUST call
// verifyInvoicePayToken on render — never trust this output for auth.

export interface UnverifiedPayTokenPayload {
  invoiceId?: string;
  tenantId?: string;
  v?: number;
  exp?: number;
}

function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64").toString("utf8");
}

export function decodePayTokenUnverified(
  token: string,
): UnverifiedPayTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Record<
      string,
      unknown
    >;
    return {
      invoiceId:
        typeof payload.invoiceId === "string" ? payload.invoiceId : undefined,
      tenantId:
        typeof payload.tenantId === "string" ? payload.tenantId : undefined,
      v: typeof payload.v === "number" ? payload.v : undefined,
      exp: typeof payload.exp === "number" ? payload.exp : undefined,
    };
  } catch {
    return null;
  }
}
