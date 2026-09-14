import { Suspense } from "react";
import { NewInvoiceForm } from "@/components/invoices/NewInvoiceForm";

// The form reads ?customer= with useSearchParams, which needs a Suspense
// boundary on a prerendered page (Next.js useSearchParams docs).
export default function NewInvoicePage() {
  return (
    <Suspense fallback={null}>
      <NewInvoiceForm />
    </Suspense>
  );
}
