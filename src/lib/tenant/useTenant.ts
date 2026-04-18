"use client";

import { useTenantContext, type TenantContextValue } from "./TenantContext";

/**
 * Convenience hook for consumers that always expect tenant context to be
 * mounted (e.g. dashboard subtree). Returns the full context value.
 */
export function useTenant(): TenantContextValue {
  return useTenantContext();
}
