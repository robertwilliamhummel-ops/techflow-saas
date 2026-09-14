import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FEATURE_DEFAULTS, type FeatureKey } from "@/lib/features";
import {
  DASHBOARD_NAV,
  isNavItemActive,
  visibleNavItems,
} from "@/lib/navigation/dashboardNav";

const defaults = (key: FeatureKey) => FEATURE_DEFAULTS[key];
const hrefs = (items: { href: string }[]) => items.map((item) => item.href);

describe("visibleNavItems", () => {
  it("shows an owner every item on the default plan", () => {
    expect(hrefs(visibleNavItems(DASHBOARD_NAV, { hasFeature: defaults, role: "owner" }))).toEqual([
      "/dashboard",
      "/invoices",
      "/customers",
      "/billing",
      "/settings",
    ]);
  });

  it("hides Billing from staff and from tokens without a role", () => {
    for (const role of ["staff", undefined] as const) {
      expect(hrefs(visibleNavItems(DASHBOARD_NAV, { hasFeature: defaults, role }))).not.toContain(
        "/billing",
      );
    }
    expect(hrefs(visibleNavItems(DASHBOARD_NAV, { hasFeature: defaults, role: "admin" }))).toContain(
      "/billing",
    );
  });

  it("hides Invoices when the plan doesn't include them", () => {
    const hasFeature = (key: FeatureKey) => key !== "invoices" && FEATURE_DEFAULTS[key];
    expect(hrefs(visibleNavItems(DASHBOARD_NAV, { hasFeature, role: "owner" }))).not.toContain(
      "/invoices",
    );
  });
});

describe("isNavItemActive", () => {
  it("matches the page and pages beneath it", () => {
    expect(isNavItemActive("/invoices", "/invoices")).toBe(true);
    expect(isNavItemActive("/invoices/new", "/invoices")).toBe(true);
    expect(isNavItemActive("/settings/team", "/settings")).toBe(true);
  });

  it("doesn't match a different page sharing the prefix", () => {
    expect(isNavItemActive("/invoices-archive", "/invoices")).toBe(false);
    expect(isNavItemActive("/dashboard", "/invoices")).toBe(false);
    expect(isNavItemActive(null, "/dashboard")).toBe(false);
  });
});

describe("DASHBOARD_NAV", () => {
  it("links only to pages that exist", () => {
    for (const item of DASHBOARD_NAV) {
      const page = path.join(process.cwd(), "src", "app", "(dashboard)", item.href, "page.tsx");
      expect(existsSync(page), `${item.href} has no page at ${page}`).toBe(true);
    }
  });
});
