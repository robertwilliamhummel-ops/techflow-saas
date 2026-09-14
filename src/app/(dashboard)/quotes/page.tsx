import { Suspense } from "react";
import { QuotesList } from "./QuotesList";

// The list reads ?status= with useSearchParams, which needs a Suspense
// boundary on a prerendered page (Next.js useSearchParams docs).
export default function QuotesListPage() {
  return (
    <Suspense fallback={null}>
      <QuotesList />
    </Suspense>
  );
}
