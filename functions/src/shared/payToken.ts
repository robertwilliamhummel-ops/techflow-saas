// Pay-token JWT helpers — shared across verifyInvoicePayToken,
// createPayTokenCheckoutSession, and regenerateInvoicePayLink.
//
// The JWT is the bearer-auth for the public pay page. Signature +
// expiry enforced by jsonwebtoken; payTokenVersion enforced by caller
// against the Firestore doc (C2 guard).

import { decode, sign, verify, type JwtPayload, type SignOptions } from "jsonwebtoken";
import { isIsoCalendarDate } from "./dates";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A pay link lives 60 days (the JWT's exp; signPayToken's default). */
export const PAY_LINK_TTL_MS = 60 * DAY_MS;

/**
 * The least life a pay link may have left when an email carries it. 30 days is
 * the app's default payment term (net 30) and one billing cycle, so a customer
 * who pays on the usual terms from the day the email arrives, or a late payer
 * resent an overdue invoice, still finds a working link. It is half the link's
 * 60-day life, so a resend in the first half reuses the link — links in earlier
 * emails keep working — and resending can't re-issue more than once a month.
 */
export const PAY_LINK_MIN_REMAINING_MS = 30 * DAY_MS;

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

/**
 * When the stored pay token expires, from its own exp claim — the authoritative
 * expiry (P3; payTokenExpiresAt is display-only). Null when there is no token
 * or it can't be decoded. Not a verification: the token was signed by us and
 * is read from the invoice, which only the Admin SDK writes.
 */
export function payTokenExpiryMs(token: unknown): number | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const decoded = decode(token);
  if (!decoded || typeof decoded === "string" || typeof decoded.exp !== "number") {
    return null;
  }
  return decoded.exp * 1000;
}

/**
 * Whether an invoice email needs a new pay link before it goes out: the token
 * is missing or unreadable, has expired or has less than
 * PAY_LINK_MIN_REMAINING_MS left, or expires before the due date ends when a
 * new 60-day link would outlast it (a due date further out than that can't be
 * helped by re-issuing, so the link is kept rather than churned on every send).
 */
export function payLinkNeedsReissue(
  token: unknown,
  dueDate: unknown,
  nowMs: number,
): boolean {
  const expiresMs = payTokenExpiryMs(token);
  if (expiresMs === null || expiresMs - nowMs < PAY_LINK_MIN_REMAINING_MS) {
    return true;
  }
  const dueEndMs = dueDateEndMs(dueDate);
  return (
    dueEndMs !== null && expiresMs < dueEndMs && nowMs + PAY_LINK_TTL_MS >= dueEndMs
  );
}

// The end of a YYYY-MM-DD due date in every Canadian time zone: noon UTC the
// next day is past midnight from Newfoundland (UTC-3:30) to Pacific (UTC-8).
function dueDateEndMs(dueDate: unknown): number | null {
  if (typeof dueDate !== "string" || !isIsoCalendarDate(dueDate)) return null;
  const [year, month, day] = dueDate.split("-").map(Number);
  return Date.UTC(year, month - 1, day + 1, 12);
}
