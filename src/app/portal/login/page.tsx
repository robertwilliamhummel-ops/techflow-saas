import type { Metadata } from "next";
import { headers } from "next/headers";

import { getTenantBranding } from "@/lib/tenant/getTenantBranding";
import { PortalLoginForm } from "./PortalLoginForm";

export const runtime = "nodejs";

const PLATFORM_DEFAULT: Metadata = {
  title: "Sign in — TechFlow",
  icons: { icon: "/favicon.ico" },
};

export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const tenantId = h.get("x-tenant-id");
  if (!tenantId) return PLATFORM_DEFAULT;
  const branding = await getTenantBranding(tenantId);
  if (!branding) return PLATFORM_DEFAULT;
  return {
    title: `Sign in — ${branding.name}`,
    icons: { icon: branding.faviconUrl ?? "/favicon.ico" },
  };
}

// Branded portal login (Phase 5 / Bundle E).
//
// React Server Component — middleware injects `x-tenant-id` for custom hosts,
// we resolve branding via Admin SDK (rules block unauthenticated reads of
// tenant meta), and pass the branding values to the client form. Customers
// land here from a per-tenant URL like `https://invoices.smithplumbing.ca`.
//
// Generic portal hosts have no `x-tenant-id` header — falls back to the
// platform-branded form.
export default async function PortalLoginPage() {
  const h = await headers();
  const tenantId = h.get("x-tenant-id");
  const branding = tenantId ? await getTenantBranding(tenantId) : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <PortalLoginForm
        tenantName={branding?.name ?? null}
        logoUrl={branding?.logoUrl ?? null}
        primaryColor={branding?.primaryColor ?? null}
      />
    </div>
  );
}
