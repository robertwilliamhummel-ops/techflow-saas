import "server-only";
import type { Metadata } from "next";
import { headers } from "next/headers";

import { isDocId } from "@/lib/portal/portalDocument";
import { getTenantBranding } from "@/lib/tenant/getTenantBranding";

/**
 * Tab title and favicon for a portal invoice or quote page (S-08): the business
 * from the custom domain (src/proxy.ts sets x-tenant-id), else the page's
 * `?tenantId` on the shared portal host (blueprint, "Portal & pay-page metadata
 * injection"). Anything else keeps the portal layout's platform default.
 * Private pages, so never indexed.
 */
export async function portalDocumentMetadata(
  kind: "Invoice" | "Quote",
  rawTenantId: unknown,
): Promise<Metadata> {
  const hostTenantId = (await headers()).get("x-tenant-id");
  const tenantId = hostTenantId ?? (isDocId(rawTenantId) ? rawTenantId : null);
  const robots = { index: false, follow: false };
  if (!tenantId) return { robots };

  const branding = await getTenantBranding(tenantId);
  if (!branding) return { robots };

  return {
    title: branding.name,
    icons: { icon: branding.faviconUrl ?? "/favicon.ico" },
    openGraph: {
      title: `${kind} from ${branding.name}`,
      images: branding.logoUrl ? [branding.logoUrl] : [],
    },
    robots,
  };
}
