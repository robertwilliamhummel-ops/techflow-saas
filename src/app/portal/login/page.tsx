import type { Metadata } from "next";
import { headers } from "next/headers";

import { safePortalReturnPath } from "@/lib/auth/guardRedirects";
import { tenantIdFromReturnPath } from "@/lib/portal/portalSignIn";
import { getTenantBranding } from "@/lib/tenant/getTenantBranding";
import { PortalLoginForm } from "./PortalLoginForm";

export const runtime = "nodejs";

const PLATFORM_DEFAULT: Metadata = {
  title: "Sign in — TechFlow",
  icons: { icon: "/favicon.ico" },
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

// The business the login is for: the custom domain (src/proxy.ts sets
// x-tenant-id, stripping any client value), else the tenantId in the page the
// customer is signing in to reach (S-10). Generic hosts without either get the
// platform-branded form.
async function resolveLogin(searchParams: SearchParams) {
  const [h, query] = await Promise.all([headers(), searchParams]);
  const next = safePortalReturnPath(typeof query.next === "string" ? query.next : null);
  const tenantId = h.get("x-tenant-id") ?? tenantIdFromReturnPath(next);
  const branding = tenantId ? await getTenantBranding(tenantId) : null;
  return { next, branding };
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const { branding } = await resolveLogin(searchParams);
  if (!branding) return PLATFORM_DEFAULT;
  return {
    title: `Sign in — ${branding.name}`,
    icons: { icon: branding.faviconUrl ?? "/favicon.ico" },
  };
}

// Branded portal login (Phase 5 / Bundle E; email-link sign-in S-10).
//
// React Server Component — resolves branding via Admin SDK (rules block
// unauthenticated reads of tenant meta) and passes it, with the checked return
// path, to the client form.
export default async function PortalLoginPage({ searchParams }: { searchParams: SearchParams }) {
  const { next, branding } = await resolveLogin(searchParams);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <PortalLoginForm
        tenantName={branding?.name ?? null}
        logoUrl={branding?.logoUrl ?? null}
        primaryColor={branding?.primaryColor ?? null}
        next={next}
      />
    </div>
  );
}
