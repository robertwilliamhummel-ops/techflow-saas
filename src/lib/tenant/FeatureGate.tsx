"use client";

import type { ReactNode } from "react";
import { useTenantContext } from "./TenantContext";
import type { FeatureKey } from "@/lib/features";

export interface FeatureGateProps {
  feature: FeatureKey;
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Renders `children` only when the tenant has the given feature enabled.
 * While tenant data is loading, renders `fallback` (defaults to null) so
 * gated UI never flashes before entitlements resolve.
 */
export function FeatureGate({ feature, fallback = null, children }: FeatureGateProps) {
  const { hasFeature, loading } = useTenantContext();
  if (loading) return <>{fallback}</>;
  if (!hasFeature(feature)) return <>{fallback}</>;
  return <>{children}</>;
}
