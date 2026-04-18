import { PortalAuthGuard } from "@/lib/auth/AuthGuard";
import { PortalShell } from "./PortalShell";

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
