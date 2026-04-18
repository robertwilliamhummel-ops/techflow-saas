"use client";

import { CustomerPortalProvider } from "@/lib/portal/CustomerPortalContext";

// Portal is light-mode and intentionally NEUTRAL. Per-document branding
// (logo, primaryColor) comes from each invoice's tenantSnapshot — applied
// inside the document detail/list rendering, not at the shell level.
export function PortalShell({ children }: { children: React.ReactNode }) {
  return (
    <CustomerPortalProvider>
      <div className="min-h-screen bg-background text-foreground">{children}</div>
    </CustomerPortalProvider>
  );
}
