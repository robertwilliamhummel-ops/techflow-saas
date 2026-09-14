"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./useAuth";
import { dashboardGuardRedirect, portalGuardRedirect } from "./guardRedirects";

function Spinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
    </div>
  );
}

/**
 * Wraps dashboard pages. Requires a tenantId claim and a verified email.
 * Redirects to /login if unauthenticated, /verify-email if unverified.
 */
export function DashboardAuthGuard({ children }: { children: React.ReactNode }) {
  const { user, claims, loading } = useAuth();
  const router = useRouter();
  const redirect = loading ? null : dashboardGuardRedirect(user, claims);

  useEffect(() => {
    if (redirect) router.replace(redirect);
  }, [redirect, router]);

  if (loading) return <Spinner />;
  if (redirect) return null;
  return <>{children}</>;
}

/**
 * Wraps portal pages. Requires email_verified and NO tenantId claim
 * (customers don't have tenantId).
 */
export function PortalAuthGuard({ children }: { children: React.ReactNode }) {
  const { user, claims, loading } = useAuth();
  const router = useRouter();
  const redirect = loading ? null : portalGuardRedirect(user, claims);

  useEffect(() => {
    if (redirect) router.replace(redirect);
  }, [redirect, router]);

  if (loading) return <Spinner />;
  if (redirect) return null;
  return <>{children}</>;
}
