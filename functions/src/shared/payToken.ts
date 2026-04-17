// Pay-token JWT helpers — shared across verifyInvoicePayToken,
// createPayTokenCheckoutSession, and regenerateInvoicePayLink.
//
// The JWT is the bearer-auth for the public pay page. Signature +
// expiry enforced by jsonwebtoken; payTokenVersion enforced by caller
// against the Firestore doc (C2 guard).

import { sign, verify, type JwtPayload, type SignOptions } from "jsonwebtoken";

export interface PayTokenPayload {
  invoiceId: string;
  tenantId: string;
  v: number; // payTokenVersion
}

/**
 * Sign a new pay token. Called by createInvoice and regenerateInvoicePayLink.
 */
export function signPayToken(
  payload: PayTokenPayload,
  secret: string,
  expiresIn: SignOptions["expiresIn"] = "60d",
): string {
  return sign(
    { invoiceId: payload.invoiceId, tenantId: payload.tenantId, v: payload.v },
    secret,
    { expiresIn },
  );
}

/**
 * Verify and decode a pay token. Throws on invalid signature or expiry.
 * Caller must still check payTokenVersion against the Firestore doc.
 */
export function verifyPayToken(
  token: string,
  secret: string,
): PayTokenPayload {
  const decoded = verify(token, secret) as JwtPayload & PayTokenPayload;
  if (
    typeof decoded.invoiceId !== "string" ||
    typeof decoded.tenantId !== "string" ||
    typeof decoded.v !== "number"
  ) {
    throw new Error("Malformed pay token payload");
  }
  return {
    invoiceId: decoded.invoiceId,
    tenantId: decoded.tenantId,
    v: decoded.v,
  };
}
