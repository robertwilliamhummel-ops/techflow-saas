import type { Metadata } from "next";

import { DashboardAuthGuard } from "@/lib/auth/AuthGuard";
import { DashboardShell } from "./DashboardShell";
import { platformMetadata } from "@/lib/platformMetadata";

export function generateMetadata(): Promise<Metadata> {
  return platformMetadata();
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DashboardAuthGuard>
      <DashboardShell>{children}</DashboardShell>
    </DashboardAuthGuard>
  );
}
