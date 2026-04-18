"use client";

import { computeForeground } from "@/lib/design/contrast";

// TODO(Bundle B): Replace with TenantProvider reading real meta from Firestore.
// Placeholder colors are used only until TenantContext is wired.
const PLACEHOLDER_TENANT = {
  primaryColor: "#0066CC",
  secondaryColor: "#F5F5F5",
};

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const t = PLACEHOLDER_TENANT;
  return (
    <div
      className="dark min-h-screen bg-background text-foreground"
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
