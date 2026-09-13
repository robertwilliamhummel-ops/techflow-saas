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

interface LoadedInvoices {
  uid: string;
  invoices: CustomerInvoiceListItem[];
  error: Error | null;
}

const EMPTY_INVOICES: CustomerInvoiceListItem[] = [];

// Never throws, so callers only set state once the request settles.
async function fetchCustomerInvoices(): Promise<Omit<LoadedInvoices, "uid">> {
  try {
    const fn = httpsCallable<unknown, { invoices: CustomerInvoiceListItem[] }>(
      getClientFunctions(),
      "getCustomerInvoices",
    );
    const result = await fn();
    return { invoices: result.data.invoices ?? [], error: null };
  } catch (err) {
    return { invoices: [], error: err as Error };
  }
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
  // Only a signed-in user without a tenant claim is a portal customer.
  const uid = user && !claims.tenantId ? user.uid : null;

  // Results are tagged with the customer they were fetched for and derived
  // below, so one customer's invoices never render for the next sign-in.
  const [loaded, setLoaded] = useState<LoadedInvoices | null>(null);

  useEffect(() => {
    if (authLoading || !uid) return;
    let active = true;
    void fetchCustomerInvoices().then((next) => {
      // Ignore a late response for a customer who is no longer signed in.
      if (active) setLoaded({ uid, ...next });
    });
    return () => {
      active = false;
    };
  }, [authLoading, uid]);

  const reload = useCallback(async () => {
    if (!uid) return;
    const next = await fetchCustomerInvoices();
    // Don't overwrite results that already belong to a different customer.
    setLoaded((prev) => (prev && prev.uid !== uid ? prev : { uid, ...next }));
  }, [uid]);

  const current = uid && loaded?.uid === uid ? loaded : null;
  const invoices = current?.invoices ?? EMPTY_INVOICES;
  const loading = !!uid && current === null;
  const error = current?.error ?? null;

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
      reload,
      getInvoice: (id) => invoices.find((inv) => inv.id === id),
      getTenantBranding: (item) => item.tenantBranding,
    }),
    [customerEmail, invoices, authLoading, loading, error, reload],
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
