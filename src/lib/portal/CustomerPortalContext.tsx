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
import { CUSTOMER_READ_TIMEOUT_MS } from "@/lib/firebase/callOptions";
import { getClientFunctions } from "@/lib/firebase/client";
import { useAuth } from "@/lib/auth/useAuth";

export interface CustomerInvoiceListItem {
  id: string;
  path: string;
  tenantId: string;
  customer: { name: string; email: string };
  totals: { subtotal: number; taxAmount: number; total: number };
  /** The business's currency for this document (S-07). */
  currency: string;
  /** Paid so far on a partly paid invoice, in cents (S-07). */
  paidAmountCents: number | null;
  status: string;
  dueDate: string;
  issueDate: string;
  tenantBranding: {
    name: string;
    // Immutable https copy of the logo from the invoice snapshot (A-05/A-06);
    // the list never carries inlined image data.
    logoUrl: string | null;
    primaryColor: string;
  };
}

// Same shape getCustomerQuotes returns (P-06).
export interface CustomerQuoteListItem {
  id: string;
  path: string;
  tenantId: string;
  customer: { name: string; email: string };
  totals: { subtotal: number; taxAmount: number; total: number };
  currency: string;
  status: string;
  validUntil: string;
  issueDate: string;
  tenantBranding: CustomerInvoiceListItem["tenantBranding"];
}

export interface CustomerPortalContextValue {
  customerEmail: string | null;
  invoices: CustomerInvoiceListItem[];
  quotes: CustomerQuoteListItem[];
  loading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
  getInvoice: (id: string) => CustomerInvoiceListItem | undefined;
  getQuote: (id: string) => CustomerQuoteListItem | undefined;
  getTenantBranding: (
    item: Pick<CustomerInvoiceListItem, "tenantBranding">,
  ) => CustomerInvoiceListItem["tenantBranding"];
}

interface LoadedPortal {
  uid: string;
  invoices: CustomerInvoiceListItem[];
  quotes: CustomerQuoteListItem[];
  error: Error | null;
}

const EMPTY_INVOICES: CustomerInvoiceListItem[] = [];
const EMPTY_QUOTES: CustomerQuoteListItem[] = [];

// Never throws, so callers only set state once both requests settle. A list
// that fails comes back empty with its error; the other list still shows.
async function fetchPortalLists(): Promise<Omit<LoadedPortal, "uid">> {
  let functions: ReturnType<typeof getClientFunctions>;
  try {
    functions = getClientFunctions();
  } catch (err) {
    return { invoices: [], quotes: [], error: err as Error };
  }

  const [invoices, quotes] = await Promise.allSettled([
    httpsCallable<unknown, { invoices: CustomerInvoiceListItem[] }>(
      functions,
      "getCustomerInvoices",
      { timeout: CUSTOMER_READ_TIMEOUT_MS },
    )(),
    httpsCallable<unknown, { quotes: CustomerQuoteListItem[] }>(
      functions,
      "getCustomerQuotes",
      { timeout: CUSTOMER_READ_TIMEOUT_MS },
    )(),
  ]);

  return {
    invoices:
      invoices.status === "fulfilled" ? (invoices.value.data.invoices ?? []) : [],
    quotes: quotes.status === "fulfilled" ? (quotes.value.data.quotes ?? []) : [],
    error:
      invoices.status === "rejected"
        ? (invoices.reason as Error)
        : quotes.status === "rejected"
          ? (quotes.reason as Error)
          : null,
  };
}

const CustomerPortalContext = createContext<CustomerPortalContextValue>({
  customerEmail: null,
  invoices: [],
  quotes: [],
  loading: true,
  error: null,
  reload: async () => {},
  getInvoice: () => undefined,
  getQuote: () => undefined,
  getTenantBranding: (item) => item.tenantBranding,
});

export function CustomerPortalProvider({ children }: { children: ReactNode }) {
  const { user, claims, loading: authLoading } = useAuth();
  const customerEmail = user?.email ?? null;
  // Only a signed-in user without a tenant claim is a portal customer.
  const uid = user && !claims.tenantId ? user.uid : null;

  // Results are tagged with the customer they were fetched for and derived
  // below, so one customer's documents never render for the next sign-in.
  const [loaded, setLoaded] = useState<LoadedPortal | null>(null);

  useEffect(() => {
    if (authLoading || !uid) return;
    let active = true;
    void fetchPortalLists().then((next) => {
      // Ignore a late response for a customer who is no longer signed in.
      if (active) setLoaded({ uid, ...next });
    });
    return () => {
      active = false;
    };
  }, [authLoading, uid]);

  const reload = useCallback(async () => {
    if (!uid) return;
    const next = await fetchPortalLists();
    // Don't overwrite results that already belong to a different customer.
    setLoaded((prev) => (prev && prev.uid !== uid ? prev : { uid, ...next }));
  }, [uid]);

  const current = uid && loaded?.uid === uid ? loaded : null;
  const invoices = current?.invoices ?? EMPTY_INVOICES;
  const quotes = current?.quotes ?? EMPTY_QUOTES;
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
      quotes,
      loading: authLoading || loading,
      error,
      reload,
      getInvoice: (id) => invoices.find((inv) => inv.id === id),
      getQuote: (id) => quotes.find((quote) => quote.id === id),
      getTenantBranding: (item) => item.tenantBranding,
    }),
    [customerEmail, invoices, quotes, authLoading, loading, error, reload],
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
