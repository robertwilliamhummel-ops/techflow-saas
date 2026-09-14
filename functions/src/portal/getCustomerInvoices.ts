// getCustomerInvoices — Phase 2 Bundle F.
//
// Customer-facing: requires email_verified, NO tenantId claim.
// Returns invoices across all tenants where customer.email matches the
// caller's verified email, newest first, projected for list display (R8).
//
// A-05: drafts are never listed — only customer-visible statuses. The filter is
// applied while paging through the (customer.email, createdAt) collection-group
// index, so no further composite index is needed and the list still fills to
// its limit when a customer also has drafts. Rows carry the snapshot's logo
// URL, never inlined image data: a callable response is capped at 10 MB. (D7
// later removed the base64 logo from stored snapshots altogether.)

import { onCall, type CallableRequest } from "firebase-functions/v2/https";
import { db } from "../shared/admin";
import { readClaims, requireVerifiedCustomer } from "../shared/auth";
import { lowerEmail } from "../shared/email";
import { isCustomerVisibleInvoiceStatus } from "../shared/customerVisibility";
import { withSentryCallable } from "../shared/withSentry";

export const CUSTOMER_INVOICE_LIST_LIMIT = 100;

// Bounds the documents scanned for one list (pages × page size), so a customer
// with an unusual number of hidden documents can't turn one call into
// thousands of reads.
const MAX_PAGES = 10;

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
    logoUrl: string | null;
    primaryColor: string;
  };
}

function toListItem(
  doc: FirebaseFirestore.QueryDocumentSnapshot,
): CustomerInvoiceListItem {
  const d = doc.data();
  // tenants/{tenantId}/invoices/{id}
  const tenantId = doc.ref.path.split("/")[1];
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
    status: d.status,
    dueDate: d.dueDate ?? "",
    issueDate: d.issueDate ?? "",
    tenantBranding: {
      name: d.tenantSnapshot?.name ?? "",
      logoUrl:
        typeof d.tenantSnapshot?.logoUrl === "string"
          ? d.tenantSnapshot.logoUrl
          : null,
      primaryColor: d.tenantSnapshot?.primaryColor ?? "#667eea",
    },
  };
}

export async function listCustomerInvoices(
  email: string,
  options: { limit?: number; pageSize?: number } = {},
): Promise<CustomerInvoiceListItem[]> {
  const limit = options.limit ?? CUSTOMER_INVOICE_LIST_LIMIT;
  const pageSize = options.pageSize ?? limit;

  // C2 — invoices store a lowercased customer.email.
  const base = db
    .collectionGroup("invoices")
    .where("customer.email", "==", lowerEmail(email))
    .orderBy("createdAt", "desc");

  const items: CustomerInvoiceListItem[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  for (let page = 0; page < MAX_PAGES && items.length < limit; page++) {
    const snap = await (cursor ? base.startAfter(cursor) : base)
      .limit(pageSize)
      .get();
    for (const doc of snap.docs) {
      if (!isCustomerVisibleInvoiceStatus(doc.get("status"))) continue;
      items.push(toListItem(doc));
      if (items.length === limit) break;
    }
    if (snap.size < pageSize) break;
    cursor = snap.docs[snap.docs.length - 1];
  }

  return items;
}

export async function getCustomerInvoicesHandler(
  request: CallableRequest,
): Promise<{ invoices: CustomerInvoiceListItem[] }> {
  const claims = readClaims(request);
  const { email } = requireVerifiedCustomer(claims);
  return { invoices: await listCustomerInvoices(email) };
}

export const getCustomerInvoices = onCall(
  withSentryCallable("getCustomerInvoices", getCustomerInvoicesHandler),
);
