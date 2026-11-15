// Dual-auth verification for the PDF proxy routes.
//
// Two callers can request a PDF for tenants/{tenantId}/invoices/{invoiceId}:
//   - Tenant user — token has `tenantId` claim that matches the invoice path.
//   - Customer    — token has email_verified=true AND token email matches
//                    the invoice's `customer.email` (case-insensitive), AND the
//                    document is in a status customers may see (A-05, S-08).
//
// Anything else gets the same 404 a missing document gets, so a signed-in
// stranger can't use the routes to learn which businesses or document numbers
// exist (audit 2026-11-13). authorizePdfCaller runs before anything is read,
// authorizePdfAccess right after the document is read and before anything else
// about it (its feature flags, its shape) can show in the answer. The proxy is
// the single security boundary; Cloud Run trusts the proxy.

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

export const PDF_NOT_FOUND = "Document not found.";

function notFound(): PdfAuthError {
  return new PdfAuthError(404, PDF_NOT_FOUND);
}

// A single Firestore document id (functions' requireDocId), so a query param
// can't address another path.
const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The checks that need no document: the ids are plain document ids, a business
 * user asks only for its own tenant, and anyone else has a verified email.
 */
export function authorizePdfCaller(
  decoded: DecodedIdToken,
  ids: { tenantId: string; documentId: string },
): PdfAuthMode {
  if (!DOC_ID.test(ids.tenantId) || !DOC_ID.test(ids.documentId)) throw notFound();
  const tokenTenantId = (decoded as DecodedIdToken & { tenantId?: unknown })
    .tenantId;
  if (typeof tokenTenantId === "string" && tokenTenantId.length > 0) {
    if (tokenTenantId !== ids.tenantId) throw notFound();
    return "tenant";
  }
  if (decoded.email_verified !== true || typeof decoded.email !== "string" || !decoded.email) {
    throw notFound();
  }
  return "customer";
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
  /** Whether the document's status is one customers see (never a draft). */
  customerMayView: boolean;
}

export function authorizePdfAccess(
  decoded: DecodedIdToken,
  opts: AuthorizeOptions,
): PdfAuthResult {
  const tokenTenantId = (decoded as DecodedIdToken & { tenantId?: unknown })
    .tenantId;

  if (typeof tokenTenantId === "string" && tokenTenantId.length > 0) {
    if (tokenTenantId !== opts.tenantId) throw notFound();
    return { uid: decoded.uid, mode: "tenant" };
  }

  const emailVerified = decoded.email_verified === true;
  const tokenEmail = typeof decoded.email === "string" ? decoded.email : "";
  const customerMatches =
    tokenEmail.toLowerCase() === opts.customerEmail.toLowerCase();

  // S-08: a customer never gets a draft, answered as if it didn't exist.
  if (!emailVerified || !tokenEmail || !customerMatches || !opts.customerMayView) {
    throw notFound();
  }
  return { uid: decoded.uid, mode: "customer" };
}
