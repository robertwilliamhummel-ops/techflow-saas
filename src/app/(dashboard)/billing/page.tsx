import { Suspense } from "react";
import { BillingClient } from "./BillingClient";

export default function BillingPage() {
  return (
    <Suspense
      fallback={
        <div className="p-8">
          <h1 className="text-2xl font-semibold">Billing</h1>
          <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
        </div>
      }
    >
      <BillingClient />
    </Suspense>
  );
}
