// Dashboard menu (blueprint Phase 3, "Navigation gating"). Items are filtered
// by feature and role; Cloud Functions still enforce both. Quotes joins the
// menu with its list page (S-06).

import type { FeatureKey } from "@/lib/features";
import type { MembershipRole } from "@/lib/schema/tenant";

export type DashboardNavIcon =
  | "dashboard"
  | "invoices"
  | "customers"
  | "billing"
  | "settings";

export interface DashboardNavItem {
  href: string;
  label: string;
  icon: DashboardNavIcon;
  feature?: FeatureKey;
  roles?: readonly MembershipRole[];
}

export const DASHBOARD_NAV: readonly DashboardNavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/invoices", label: "Invoices", icon: "invoices", feature: "invoices" },
  { href: "/customers", label: "Customers", icon: "customers" },
  // Stripe onboarding is owner/admin only (startConnectOnboarding).
  { href: "/billing", label: "Billing", icon: "billing", roles: ["owner", "admin"] },
  { href: "/settings", label: "Settings", icon: "settings" },
];

export function isOwnerOrAdmin(role: MembershipRole | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function visibleNavItems(
  items: readonly DashboardNavItem[],
  access: {
    hasFeature: (key: FeatureKey) => boolean;
    role: MembershipRole | undefined;
  },
): DashboardNavItem[] {
  return items.filter(
    (item) =>
      (!item.feature || access.hasFeature(item.feature)) &&
      (!item.roles || (access.role !== undefined && item.roles.includes(access.role))),
  );
}

/** An item is active on its own page and every page beneath it. */
export function isNavItemActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
