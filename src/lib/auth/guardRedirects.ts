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

/** Portal pages need a verified email and no tenant claim. */
export function portalGuardRedirect(
  user: GuardUser | null,
  claims: AuthClaims,
): string | null {
  if (!user) return "/portal/login";
  if (claims.tenantId) return "/dashboard";
  if (!claims.email_verified) return "/portal/login";
  return null;
}
