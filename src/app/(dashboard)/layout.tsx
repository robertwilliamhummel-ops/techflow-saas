import { computeForeground } from "@/lib/design/contrast";

// TODO(Phase 3 / Phase 5): replace this hardcoded placeholder with the real
// tenant resolved by middleware from the auth claim (`tenantId`) or the custom
// domain reverse-lookup. DO NOT SHIP placeholder colors to production — the
// dashboard must render the authenticated tenant's actual brand.
const PLACEHOLDER_TENANT = {
  primaryColor: "#0066CC",
  secondaryColor: "#F5F5F5",
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
