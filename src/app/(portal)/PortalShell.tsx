"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth/useAuth";
import { CustomerPortalProvider } from "@/lib/portal/CustomerPortalContext";

// Portal is light-mode and intentionally NEUTRAL. Per-document branding
// (logo, primaryColor) comes from each invoice's tenantSnapshot — applied
// inside the document detail/list rendering, not at the shell level. The header
// names no business and no platform, so it reads right on any custom domain.
export function PortalShell({ children }: { children: React.ReactNode }) {
  const { signOut } = useAuth();
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    router.replace("/portal/login");
  }

  return (
    <CustomerPortalProvider>
      <div className="min-h-screen bg-background text-foreground">
        <header className="border-b bg-card">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
            <Link
              href="/portal"
              className="rounded-md text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Invoices &amp; quotes
            </Link>
            <Button variant="outline" size="sm" onClick={handleSignOut}>
              <LogOut aria-hidden data-icon="inline-start" />
              Sign out
            </Button>
          </div>
        </header>
        {children}
      </div>
    </CustomerPortalProvider>
  );
}
