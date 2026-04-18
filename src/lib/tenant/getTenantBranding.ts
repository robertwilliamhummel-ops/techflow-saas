import "server-only";
import { getAdminDb } from "@/lib/firebase/admin";

export interface TenantBranding {
  name: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string;
}

/**
 * Server-only — fetches the minimal branding fields the portal/pay
 * layouts need for tab title + favicon. Reads `tenants/{id}/meta/settings`
 * via Admin SDK (rules block unauthenticated reads of meta).
 *
 * Returns null when the tenant doc is missing OR admin env is not configured
 * (build environment without Firebase secrets) — caller falls back to the
 * platform default branding.
 */
export async function getTenantBranding(
  tenantId: string,
): Promise<TenantBranding | null> {
  if (!process.env.FIREBASE_ADMIN_CLIENT_EMAIL) return null;
  try {
    const snap = await getAdminDb()
      .doc(`tenants/${tenantId}/meta/settings`)
      .get();
    if (!snap.exists) return null;
    const d = snap.data()!;
    return {
      name: typeof d.name === "string" ? d.name : "Invoice",
      logoUrl: typeof d.logoUrl === "string" ? d.logoUrl : null,
      faviconUrl: typeof d.faviconUrl === "string" ? d.faviconUrl : null,
      primaryColor:
        typeof d.primaryColor === "string" ? d.primaryColor : "#0066CC",
    };
  } catch {
    return null;
  }
}
