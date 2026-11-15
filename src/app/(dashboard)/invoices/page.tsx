import type { Metadata } from "next";
import { Suspense } from "react";
import { InvoicesList } from "./InvoicesList";

export const metadata: Metadata = { title: "Invoices" };

// The list reads ?status= with useSearchParams, which needs a Suspense
// boundary on a prerendered page (Next.js useSearchParams docs).
export default function InvoicesListPage() {
  return (
    <Suspense fallback={null}>
      <InvoicesList />
    </Suspense>
  );
}
