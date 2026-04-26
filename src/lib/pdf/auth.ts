// Dual-auth verification for the PDF proxy routes.
//
// Two callers can request a PDF for tenants/{tenantId}/invoices/{invoiceId}:
//   - Tenant user — token has `tenantId` claim that matches the invoice path.
//   - Customer    — token has email_verified=true AND token email matches
//                    the invoice's `customer.email` (case-insensitive).
//
// Anything else → 403. The proxy is the single security boundary; Cloud Run
// trusts the proxy.

import { getAdminAuth } from "@/lib/firebase/admin";
import type { DecodedIdToken } from "firebase-admin/auth";

export type PdfAuthMode = "tenant" | "customer";

export interface PdfAuthResult {
  uid: string;
  mode: PdfAuthMode;
}

export class PdfAuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PdfAuthError";
    this.status = status;
  }
}

export function readBearerToken(req: Request): string {
  const header = req.headers.get("authorization");
  if (!header || !/^Bearer\s+/i.test(header)) {
    throw new PdfAuthError(401, "Missing Authorization: Bearer header.");
  }
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    throw new PdfAuthError(401, "Empty bearer token.");
  }
  return token;
}

export async function verifyIdToken(token: string): Promise<DecodedIdToken> {
  try {
    return await getAdminAuth().verifyIdToken(token, true);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "verifyIdToken failed";
    throw new PdfAuthError(401, `Invalid ID token: ${reason}`);
  }
}

export interface AuthorizeOptions {
  tenantId: string;
  customerEmail: string;
}

export function authorizePdfAccess(
  decoded: DecodedIdToken,
  opts: AuthorizeOptions,
): PdfAuthResult {
  const tokenTenantId = (decoded as DecodedIdToken & { tenantId?: unknown })
    .tenantId;

  if (typeof tokenTenantId === "string" && tokenTenantId.length > 0) {
    if (tokenTenantId !== opts.tenantId) {
      throw new PdfAuthError(
        403,
        "Tenant claim does not match invoice path.",
      );
    }
    return { uid: decoded.uid, mode: "tenant" };
  }

  const emailVerified = decoded.email_verified === true;
  const tokenEmail = typeof decoded.email === "string" ? decoded.email : "";
  const customerMatches =
    tokenEmail.toLowerCase() === opts.customerEmail.toLowerCase();

  if (!emailVerified || !tokenEmail || !customerMatches) {
    throw new PdfAuthError(
      403,
      "Token does not authorize access to this document.",
    );
  }
  return { uid: decoded.uid, mode: "customer" };
}
