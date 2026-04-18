"use client";

import {
  useCustomerPortalContext,
  type CustomerPortalContextValue,
} from "./CustomerPortalContext";

export function useCustomerPortal(): CustomerPortalContextValue {
  return useCustomerPortalContext();
}
