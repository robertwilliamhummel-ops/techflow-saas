"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTenantContext } from "@/lib/tenant/TenantContext";

export function BillingStatusBanner() {
  const { meta, features, loading } = useTenantContext();
  const pathname = usePathname();

  if (loading) return null;
  if (!features.stripePayments) return null;
  if (pathname?.startsWith("/billing")) return null;

  const accountId = meta?.stripeAccountId ?? null;
  const chargesEnabled = meta?.stripeStatus?.chargesEnabled === true;
  if (chargesEnabled) return null;

  const message = !accountId
    ? "Connect Stripe so customers can pay invoices by credit card."
    : "Stripe needs more information before you can accept card payments.";

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-100">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <span>{message}</span>
        <Link
          href="/billing"
          className="font-medium underline underline-offset-4 hover:text-amber-50"
        >
          Open Billing
        </Link>
      </div>
    </div>
  );
}
