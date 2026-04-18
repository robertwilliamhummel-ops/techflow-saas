"use client";

import { computeForeground } from "@/lib/design/contrast";
import { TenantProvider, useTenantContext } from "@/lib/tenant/TenantContext";

const FALLBACK_PRIMARY = "#0066CC";
const FALLBACK_SECONDARY = "#F5F5F5";

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { meta } = useTenantContext();
  const primary = meta?.primaryColor ?? FALLBACK_PRIMARY;
  const secondary = meta?.secondaryColor ?? FALLBACK_SECONDARY;
  return (
    <div
      className="dark min-h-screen bg-background text-foreground"
      style={
        {
          "--primary": primary,
          "--primary-foreground": computeForeground(primary),
          "--secondary": secondary,
          "--secondary-foreground": computeForeground(secondary),
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <TenantProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </TenantProvider>
  );
}
