"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./useAuth";

/**
 * Wraps dashboard pages. Requires a valid tenantId claim.
 * Redirects to /login if unauthenticated, /verify-email if unverified.
 */
export function DashboardAuthGuard({ children }: { children: React.ReactNode }) {
  const { user, claims, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (!claims.tenantId) {
      // Authenticated but no tenant — either a customer or unverified user.
      if (claims.email_verified) {
        router.replace("/portal");
      } else {
        router.replace("/login");
      }
    }
  }, [user, claims, loading, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
      </div>
    );
  }

  if (!user || !claims.tenantId) return null;

  return <>{children}</>;
}

/**
 * Wraps portal pages. Requires email_verified and NO tenantId claim
 * (customers don't have tenantId).
 */
export function PortalAuthGuard({ children }: { children: React.ReactNode }) {
  const { user, claims, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/portal/login");
      return;
    }
    // If user has a tenantId, they're a contractor — send to dashboard.
    if (claims.tenantId) {
      router.replace("/dashboard");
      return;
    }
    if (!claims.email_verified) {
      router.replace("/portal/login");
    }
  }, [user, claims, loading, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
      </div>
    );
  }

  if (!user || !claims.email_verified || claims.tenantId) return null;

  return <>{children}</>;
}
