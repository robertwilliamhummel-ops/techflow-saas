// Portal sign-in by email link (S-10). The emailed link returns to the portal
// login — outside the portal guard — which finishes signing in and then opens
// the page the customer asked for. Pure, so the rules are tested.

import { authErrorMessage } from "@/lib/auth/authErrors";
import { PORTAL_LOGIN_PATH, safePortalReturnPath } from "@/lib/auth/guardRedirects";
import { isDocId } from "@/lib/portal/portalDocument";

/** Where the sign-in link returns: this site's portal login, with the page to open next. */
export function signInContinueUrl(origin: string, next: string | null | undefined): string {
  const url = new URL(PORTAL_LOGIN_PATH, origin);
  const safe = safePortalReturnPath(next);
  if (safe && safe !== "/portal") url.searchParams.set("next", safe);
  return url.toString();
}

/**
 * The business a return path belongs to, so the login on the shared portal
 * host can carry its branding (blueprint: "tenant branding resolved from the
 * domain or tenantId param").
 */
export function tenantIdFromReturnPath(next: string | null | undefined): string | null {
  const safe = safePortalReturnPath(next);
  if (!safe) return null;
  const tenantId = new URL(safe, "https://portal.invalid").searchParams.get("tenantId");
  return isDocId(tenantId) ? tenantId : null;
}

export interface SignInLinkFailure {
  /**
   * wrong-email: ask for the address again. unusable-link: the link can't be
   * used, so ask for a new one. other: anything else, also answered with a new
   * request.
   */
  kind: "wrong-email" | "unusable-link" | "other";
  message: string;
}

/** Why a sign-in link didn't sign the customer in, in words for them. */
export function signInLinkFailure(err: unknown): SignInLinkFailure {
  const code = (err as { code?: unknown } | null)?.code;
  switch (code) {
    // Firebase: "The email provided does not match the sign-in email address."
    case "auth/invalid-email":
      return {
        kind: "wrong-email",
        message: "That isn't the email address this sign-in link was sent to.",
      };
    case "auth/expired-action-code":
      return {
        kind: "unusable-link",
        message: "This sign-in link has expired. Enter your email to get a new one.",
      };
    case "auth/invalid-action-code":
      return {
        kind: "unusable-link",
        message: "This sign-in link has already been used or isn't complete. Enter your email to get a new one.",
      };
    default:
      return { kind: "other", message: authErrorMessage(err) };
  }
}

/** Why asking for a sign-in link failed. sendPortalSignInLink answers ok whenever the request is valid. */
export function requestLinkErrorMessage(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "functions/invalid-argument"
    ? "Enter a valid email address."
    : "The sign-in link couldn't be sent. Check your connection and try again.";
}
