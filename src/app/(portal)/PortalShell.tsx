"use client";

import { computeForeground } from "@/lib/design/contrast";

// TODO(Bundle C): Replace with CustomerPortalContext reading per-document
// tenantSnapshot branding. The portal renders branding PER DOCUMENT, not
// from a single global tenant. This placeholder is only used until the
// customer context is wired.
const PLACEHOLDER_TENANT = {
  primaryColor: "#0066CC",
  secondaryColor: "#F5F5F5",
};

export function PortalShell({ children }: { children: React.ReactNode }) {
  const t = PLACEHOLDER_TENANT;
  return (
    <div
      className="min-h-screen bg-background text-foreground"
      style={
        {
          "--primary": t.primaryColor,
          "--primary-foreground": computeForeground(t.primaryColor),
          "--secondary": t.secondaryColor,
          "--secondary-foreground": computeForeground(t.secondaryColor),
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}
