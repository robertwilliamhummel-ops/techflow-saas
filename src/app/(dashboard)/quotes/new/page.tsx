import type { Metadata } from "next";
import { Suspense } from "react";
import { NewDocumentForm } from "@/components/documents/NewDocumentForm";

export const metadata: Metadata = { title: "New quote" };

// The form reads ?customer= with useSearchParams, which needs a Suspense
// boundary on a prerendered page (Next.js useSearchParams docs).
export default function NewQuotePage() {
  return (
    <Suspense fallback={null}>
      <NewDocumentForm kind="quote" />
    </Suspense>
  );
}
