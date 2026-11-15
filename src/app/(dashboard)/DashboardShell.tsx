"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ChevronsUpDown,
  ClipboardList,
  CreditCard,
  FileText,
  LayoutDashboard,
  LogOut,
  Settings,
  Users,
} from "lucide-react";

import { BusinessLogo } from "@/components/branding/BusinessLogo";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth/useAuth";
import {
  DASHBOARD_NAV,
  isNavItemActive,
  visibleNavItems,
  type DashboardNavIcon,
  type DashboardNavItem,
} from "@/lib/navigation/dashboardNav";
import type { MembershipRole } from "@/lib/schema/tenant";
import { TenantProvider, useTenantContext } from "@/lib/tenant/TenantContext";
import { cn } from "@/lib/utils";
import { BillingStatusBanner } from "./BillingStatusBanner";

const NAV_ICONS: Record<DashboardNavIcon, typeof LayoutDashboard> = {
  dashboard: LayoutDashboard,
  invoices: FileText,
  quotes: ClipboardList,
  customers: Users,
  billing: CreditCard,
  settings: Settings,
};

const ROLE_LABELS: Record<MembershipRole, string> = {
  owner: "Owner",
  admin: "Admin",
  staff: "Staff",
};

function initialOf(text: string, fallback: string): string {
  return (text.trim()[0] ?? fallback).toUpperCase();
}

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { meta, hasFeature, loading } = useTenantContext();
  const { user, claims, signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  // Feature-gated items wait for entitlements so they never flash in and out.
  const navItems = visibleNavItems(DASHBOARD_NAV, {
    hasFeature: (key) => !loading && hasFeature(key),
    role: claims.role,
  });

  const account: AccountInfo = {
    email: user?.email ?? "",
    name: user?.displayName || user?.email || "",
    role: claims.role,
    onSignOut: async () => {
      await signOut();
      router.replace("/login");
    },
  };

  return (
    // TechFlow's platform theme (D17, set by the layout's PlatformTheme), light
    // or dark with the system; the sidebar and phone header are navy (`dark`).
    <div className="min-h-screen bg-background text-foreground">
      <BillingStatusBanner role={claims.role} />
      <div className="md:flex">
        <aside className="dark hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:flex md:h-dvh md:w-60 md:shrink-0 md:flex-col">
          <div className="p-4">
            <TenantBrand name={meta?.name ?? ""} logoUrl={meta?.logoUrl ?? null} />
          </div>
          <nav aria-label="Main" className="flex-1 overflow-y-auto px-3">
            <NavLinks items={navItems} pathname={pathname} orientation="vertical" />
          </nav>
          <div className="border-t border-sidebar-border p-3">
            <AccountMenu account={account} compact={false} />
          </div>
        </aside>

        <header className="dark sticky top-0 z-40 border-b bg-background/95 backdrop-blur md:hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <TenantBrand name={meta?.name ?? ""} logoUrl={meta?.logoUrl ?? null} />
            <AccountMenu account={account} compact />
          </div>
          <nav aria-label="Main" className="overflow-x-auto px-4 pb-2">
            <NavLinks items={navItems} pathname={pathname} orientation="horizontal" />
          </nav>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

function TenantBrand({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  return (
    // The name sits beside a square logo and wraps under a wide one, rather
    // than being cut to a few letters.
    <Link
      href="/dashboard"
      className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {logoUrl ? (
        // The white tile keeps dark logos readable on the dark dashboard.
        <BusinessLogo src={logoUrl} maxWidth={144} maxHeight={32} tile />
      ) : (
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground"
        >
          {initialOf(name, "T")}
        </span>
      )}
      <span className="min-w-24 flex-1 truncate font-semibold">{name || "Dashboard"}</span>
    </Link>
  );
}

function NavLinks({
  items,
  pathname,
  orientation,
}: {
  items: DashboardNavItem[];
  pathname: string | null;
  orientation: "vertical" | "horizontal";
}) {
  return (
    <ul className={orientation === "vertical" ? "flex flex-col gap-0.5" : "flex gap-1"}>
      {items.map((item) => {
        const Icon = NAV_ICONS[item.icon];
        const active = isNavItemActive(pathname, item.href);
        return (
          <li key={item.href} className="shrink-0">
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                active
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

interface AccountInfo {
  email: string;
  name: string;
  role: MembershipRole | undefined;
  onSignOut: () => Promise<void>;
}

function AccountMenu({ account, compact }: { account: AccountInfo; compact: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={compact ? "Account menu" : undefined}
        className={cn(
          buttonVariants({ variant: "ghost", size: compact ? "icon-lg" : "lg" }),
          !compact && "w-full justify-start gap-2 px-2",
        )}
      >
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground"
        >
          {initialOf(account.name, "?")}
        </span>
        {compact ? null : (
          <>
            <span className="min-w-0 flex-1 truncate text-left">{account.name}</span>
            <ChevronsUpDown className="text-muted-foreground" aria-hidden />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={compact ? "end" : "start"}
        side={compact ? "bottom" : "top"}
        className="w-60"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="block truncate text-foreground">{account.email}</span>
            {account.role ? (
              <span className="block font-normal">{ROLE_LABELS[account.role]}</span>
            ) : null}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void account.onSignOut()}>
          <LogOut aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <TenantProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </TenantProvider>
  );
}
