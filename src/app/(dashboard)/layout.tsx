import type { Metadata } from "next";

import { PlatformTheme } from "@/components/theme/PlatformTheme";
import { DashboardAuthGuard } from "@/lib/auth/AuthGuard";
import { DashboardShell } from "./DashboardShell";
import { platformMetadata, showPlatformBrand } from "@/lib/platformMetadata";

export function generateMetadata(): Promise<Metadata> {
  return platformMetadata();
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const app = (
    <DashboardAuthGuard>
      <DashboardShell>{children}</DashboardShell>
    </DashboardAuthGuard>
  );
  // TechFlow's navy theme (D17) only on TechFlow's own hosts, never on a
  // business's custom domain (D13).
  return (await showPlatformBrand()) ? <PlatformTheme>{app}</PlatformTheme> : app;
}
