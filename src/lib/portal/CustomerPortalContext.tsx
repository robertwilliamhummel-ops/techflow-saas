"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { httpsCallable } from "firebase/functions";
import * as Sentry from "@sentry/nextjs";
import { getClientFunctions } from "@/lib/firebase/client";
import { useAuth } from "@/lib/auth/useAuth";

export interface CustomerInvoiceListItem {
  id: string;
  path: string;
  tenantId: string;
  customer: { name: string; email: string };
  totals: { subtotal: number; taxAmount: number; total: number };
  status: string;
  dueDate: string;
  issueDate: string;
  tenantBranding: {
    name: string;
    logo: string | null;
    primaryColor: string;
  };
}

export interface CustomerPortalContextValue {
  customerEmail: string | null;
  invoices: CustomerInvoiceListItem[];
  // Quotes endpoint not yet shipped (Phase 2 ships invoices only).
  // Slot reserved so consumers can render an empty state today.
  quotes: never[];
  loading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
  getInvoice: (id: string) => CustomerInvoiceListItem | undefined;
  getTenantBranding: (
    item: Pick<CustomerInvoiceListItem, "tenantBranding">,
  ) => CustomerInvoiceListItem["tenantBranding"];
}

const CustomerPortalContext = createContext<CustomerPortalContextValue>({
  customerEmail: null,
  invoices: [],
  quotes: [],
  loading: true,
  error: null,
  reload: async () => {},
  getInvoice: () => undefined,
  getTenantBranding: (item) => item.tenantBranding,
});

export function CustomerPortalProvider({ children }: { children: ReactNode }) {
  const { user, claims, loading: authLoading } = useAuth();
  const customerEmail = user?.email ?? null;
  const isCustomer = !!user && !claims.tenantId;

  const [invoices, setInvoices] = useState<CustomerInvoiceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    if (!isCustomer) {
      setInvoices([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const fn = httpsCallable<unknown, { invoices: CustomerInvoiceListItem[] }>(
        getClientFunctions(),
        "getCustomerInvoices",
      );
      const result = await fn();
      setInvoices(result.data.invoices ?? []);
    } catch (err) {
      setError(err as Error);
      setInvoices([]);
    } finally {
      setLoading(false);
    }
  }, [isCustomer]);

  useEffect(() => {
    if (authLoading) return;
    void load();
  }, [authLoading, load]);

  useEffect(() => {
    if (user) {
      Sentry.setUser({ id: user.uid, email: user.email ?? undefined });
      Sentry.setTag("portalCustomer", "true");
    } else {
      Sentry.setUser(null);
      Sentry.setTag("portalCustomer", "false");
    }
  }, [user]);

  const value = useMemo<CustomerPortalContextValue>(
    () => ({
      customerEmail,
      invoices,
      quotes: [] as never[],
      loading: authLoading || loading,
      error,
      reload: load,
      getInvoice: (id) => invoices.find((inv) => inv.id === id),
      getTenantBranding: (item) => item.tenantBranding,
    }),
    [customerEmail, invoices, authLoading, loading, error, load],
  );

  return (
    <CustomerPortalContext.Provider value={value}>
      {children}
    </CustomerPortalContext.Provider>
  );
}

export function useCustomerPortalContext(): CustomerPortalContextValue {
  return useContext(CustomerPortalContext);
}
