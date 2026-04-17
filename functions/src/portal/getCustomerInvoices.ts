// getCustomerInvoices — Phase 2 Bundle F.
//
// Customer-facing: requires email_verified, NO tenantId claim.
// Returns invoices across all tenants where customer.email matches the
// caller's verified email. Projected fields for list display (R8 guidance).

import { onCall, type CallableRequest } from "firebase-functions/v2/https";
import { db } from "../shared/admin";
import { readClaims, requireVerifiedCustomer } from "../shared/auth";
import { lowerEmail } from "../shared/email";

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

export async function getCustomerInvoicesHandler(
  request: CallableRequest,
): Promise<{ invoices: CustomerInvoiceListItem[] }> {
  const claims = readClaims(request);
  const { email } = requireVerifiedCustomer(claims);

  // C2 — lowercase before querying. Invoices store lowercased customer.email.
  const normalizedEmail = lowerEmail(email);

  const snap = await db
    .collectionGroup("invoices")
    .where("customer.email", "==", normalizedEmail)
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();

  const invoices: CustomerInvoiceListItem[] = snap.docs.map((doc) => {
    const d = doc.data();
    // Extract tenantId from the document path: tenants/{tenantId}/invoices/{id}
    const pathParts = doc.ref.path.split("/");
    const tenantId = pathParts[1];

    return {
      id: doc.id,
      path: doc.ref.path,
      tenantId,
      customer: {
        name: d.customer?.name ?? "",
        email: d.customer?.email ?? "",
      },
      totals: {
        subtotal: d.totals?.subtotal ?? 0,
        taxAmount: d.totals?.taxAmount ?? 0,
        total: d.totals?.total ?? 0,
      },
      status: d.status ?? "draft",
      dueDate: d.dueDate ?? "",
      issueDate: d.issueDate ?? "",
      tenantBranding: {
        name: d.tenantSnapshot?.name ?? "",
        logo: d.tenantSnapshot?.logo ?? null,
        primaryColor: d.tenantSnapshot?.primaryColor ?? "#667eea",
      },
    };
  });

  return { invoices };
}

export const getCustomerInvoices = onCall(getCustomerInvoicesHandler);
