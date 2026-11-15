import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));

import { PLATFORM_ICONS, platformMetadata } from "../platformMetadata";
import { businessTabIcon, initialTabIcon, NEUTRAL_TAB_ICON } from "../tenant/tabIcon";

const root = path.resolve(__dirname, "../../..");

function svgOf(dataUrl: string): string {
  expect(dataUrl.startsWith("data:image/svg+xml,")).toBe(true);
  return decodeURIComponent(dataUrl.slice("data:image/svg+xml,".length));
}

describe("business tab icons", () => {
  it("uses the business's own favicon when it has one", () => {
    expect(
      businessTabIcon({ name: "Acme", faviconUrl: "https://cdn.test/fav.png", primaryColor: "#123456" }),
    ).toBe("https://cdn.test/fav.png");
  });

  it("otherwise shows the business's initial on its brand colour", () => {
    const svg = svgOf(businessTabIcon({ name: " acme plumbing", faviconUrl: null, primaryColor: "#0B6A68" }));
    expect(svg).toContain('fill="#0B6A68"');
    expect(svg).toContain(">A</text>");
  });

  it("escapes the initial, ignores a colour that isn't hex, and survives an emoji", () => {
    expect(svgOf(initialTabIcon("<b>", "red"))).toContain(">&lt;</text>");
    expect(svgOf(initialTabIcon("<b>", "red"))).toContain('fill="#475569"');
    expect(svgOf(initialTabIcon("🔧 Fix-It", null))).toContain(">🔧</text>");
    expect(svgOf(initialTabIcon("", null))).toContain(">?</text>");
  });

  it("falls back to a neutral icon that is in the app", () => {
    expect(existsSync(path.join(root, "public", NEUTRAL_TAB_ICON))).toBe(true);
  });
});

describe("platform metadata", () => {
  beforeEach(() => {
    request.headers = new Headers();
  });

  it("gives TechFlow's pages its icons and a TechFlow title", async () => {
    const metadata = await platformMetadata("Join your team");
    expect(metadata.icons).toBe(PLATFORM_ICONS);
    expect(metadata.title).toEqual({ template: "%s · TechFlow", default: "Join your team · TechFlow" });
    for (const icon of [PLATFORM_ICONS.icon, PLATFORM_ICONS.apple].flat()) {
      const url = typeof icon === "object" && icon && "url" in icon ? String(icon.url) : String(icon);
      expect(existsSync(path.join(root, "public", url))).toBe(true);
    }
  });

  it("keeps TechFlow's icon off a business's custom domain", async () => {
    request.headers = new Headers({ "x-tenant-id": "acme" });
    expect((await platformMetadata()).icons).toEqual({ icon: NEUTRAL_TAB_ICON });
  });
});

describe("tenant-facing pages (D13)", () => {
  it("never fall back to TechFlow's icon or logo", () => {
    for (const file of [
      "src/app/(pay)/pay/[token]/layout.tsx",
      "src/app/(portal)/layout.tsx",
      "src/app/portal/login/page.tsx",
      "src/lib/tenant/portalMetadata.ts",
      "src/app/layout.tsx",
    ]) {
      const source = readFileSync(path.join(root, file), "utf8");
      expect(source, file).not.toMatch(/favicon\.ico|\/brand\/|PLATFORM_ICONS/);
    }
  });

  it("have no root favicon.ico, which Next.js would put on every page", () => {
    expect(existsSync(path.join(root, "src/app/favicon.ico"))).toBe(false);
    expect(existsSync(path.join(root, "public/favicon.ico"))).toBe(false);
  });
});
