import { Suspense } from "react";
import { NewDocumentForm } from "@/components/documents/NewDocumentForm";

// The form reads ?customer= with useSearchParams, which needs a Suspense
// boundary on a prerendered page (Next.js useSearchParams docs).
export default function NewQuotePage() {
  return (
    <Suspense fallback={null}>
      <NewDocumentForm kind="quote" />
    </Suspense>
  );
}
