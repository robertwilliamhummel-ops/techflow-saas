import type { Metadata } from "next";
import { headers } from "next/headers";
import { PortalAuthGuard } from "@/lib/auth/AuthGuard";
import { PortalShell } from "./PortalShell";
import { getTenantBranding } from "@/lib/tenant/getTenantBranding";

export const runtime = "nodejs";

const PLATFORM_DEFAULT: Metadata = {
  title: "TechFlow",
  icons: { icon: "/favicon.ico" },
};

export async function generateMetadata(): Promise<Metadata> {
  // Phase 5 wires middleware to inject x-tenant-id from custom domain or
  // Edge Config lookup. Until then, this resolves to the platform default.
  const h = await headers();
  const tenantId = h.get("x-tenant-id");
  if (!tenantId) return PLATFORM_DEFAULT;

  const branding = await getTenantBranding(tenantId);
  if (!branding) return PLATFORM_DEFAULT;

  return {
    title: branding.name,
    icons: { icon: branding.faviconUrl ?? "/favicon.ico" },
    openGraph: {
      title: `Invoice from ${branding.name}`,
      images: branding.logoUrl ? [branding.logoUrl] : [],
    },
  };
}

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PortalAuthGuard>
      <PortalShell>{children}</PortalShell>
    </PortalAuthGuard>
  );
}
