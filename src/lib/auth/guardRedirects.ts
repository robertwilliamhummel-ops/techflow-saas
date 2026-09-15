// Where each route-group guard sends a visitor who may not see its pages.
// Pure so the rules are testable without rendering; AuthGuard.tsx applies them.

import type { AuthClaims } from "./useAuth";

export interface GuardUser {
  // Firebase User.emailVerified — current after user.reload(), unlike the
  // email_verified token claim, which waits for the next token refresh.
  emailVerified: boolean;
}

/**
 * Dashboard pages need a tenant member with a verified email (blueprint
 * Phase 3, "Email verification gate"). Returns the redirect, or null to render.
 */
export function dashboardGuardRedirect(
  user: GuardUser | null,
  claims: AuthClaims,
): string | null {
  if (!user) return "/login";
  if (!claims.tenantId) {
    // Signed in without a tenant: a customer, or a signup that never finished.
    return claims.email_verified ? "/portal" : "/login";
  }
  if (!user.emailVerified) return "/verify-email";
  return null;
}

export const PORTAL_LOGIN_PATH = "/portal/login";

const RETURN_BASE = "https://portal.invalid";

/**
 * A portal page to come back to after sign-in (S-10), as a same-site path with
 * its query — or null for anything else: other sites, other routes, the login
 * page itself, or something that isn't a path.
 */
export function safePortalReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 1000) return null;
  if (!raw.startsWith("/portal") || raw.includes("\\")) return null;
  let url: URL;
  try {
    url = new URL(raw, RETURN_BASE);
  } catch {
    return null;
  }
  if (url.origin !== RETURN_BASE) return null;
  const path = url.pathname;
  if (path !== "/portal" && !path.startsWith("/portal/")) return null;
  if (path === PORTAL_LOGIN_PATH || path.startsWith(`${PORTAL_LOGIN_PATH}/`)) return null;
  return `${path}${url.search}`;
}

/** The portal login, remembering the page to return to when there is one. */
export function portalLoginHref(returnTo?: string | null): string {
  const next = safePortalReturnPath(returnTo);
  return next && next !== "/portal"
    ? `${PORTAL_LOGIN_PATH}?${new URLSearchParams({ next })}`
    : PORTAL_LOGIN_PATH;
}

/**
 * Portal pages need a verified email and no tenant claim. `returnTo` is the
 * page the visitor asked for, so the sign-in link can bring them back to it
 * (blueprint, "Customer magic link flow").
 */
export function portalGuardRedirect(
  user: GuardUser | null,
  claims: AuthClaims,
  returnTo?: string,
): string | null {
  if (!user) return portalLoginHref(returnTo);
  if (claims.tenantId) return "/dashboard";
  if (!claims.email_verified) return portalLoginHref(returnTo);
  return null;
}
