import type { Metadata } from "next";
import { decodePayTokenUnverified } from "@/lib/payToken/decodeUnverified";
import { getTenantBranding } from "@/lib/tenant/getTenantBranding";

// Admin SDK requires Node — Vercel must not auto-Edge this layout.
export const runtime = "nodejs";

const PLATFORM_DEFAULT: Metadata = {
  title: "Pay invoice",
  icons: { icon: "/favicon.ico" },
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  // Decode WITHOUT signature verify — only need tenantId for branding.
  // The actual page server-renders verifyInvoicePayToken on every request.
  const { token } = await params;
  const payload = decodePayTokenUnverified(token);
  if (!payload?.tenantId) return PLATFORM_DEFAULT;

  const branding = await getTenantBranding(payload.tenantId);
  if (!branding) return PLATFORM_DEFAULT;

  return {
    title: branding.name,
    icons: { icon: branding.faviconUrl ?? "/favicon.ico" },
    openGraph: {
      title: `Invoice from ${branding.name}`,
      images: branding.logoUrl ? [branding.logoUrl] : [],
    },
    robots: { index: false, follow: false },
  };
}

// Privacy headers (Referrer-Policy, X-Robots-Tag, X-Frame-Options) for
// /pay/* are set in next.config.ts headers() — Next 15 layouts don't
// support a `headers` export.
export default function PayTokenLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
