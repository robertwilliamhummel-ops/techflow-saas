import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { contrastRatio } from "./contrast";

// D17 (G-02): the platform's own screens wear TechFlow's brand through
// [data-theme="platform"] in globals.css; tenant-facing pages keep `:root`.
const css = readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");

/** The `--name: value` declarations of the first block opened by `opener`. */
function tokens(opener: string): Record<string, string> {
  const start = css.indexOf(opener);
  if (start < 0) throw new Error(`globals.css has no block ${opener}`);
  const body = css.slice(start + opener.length, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
}

const tenantLight = tokens(":root {");
const tenantDark = tokens(".dark {");
const light = tokens('[data-theme="platform"] {');
const dark = tokens("@utility platform-dark {");

const BRAND = ["#061a26", "#6be6d6", "#0b6a68"]; // Harbour Navy, Signal Aqua, Deep Teal
const colourTokens = (t: Record<string, string>) =>
  Object.keys(t).filter((k) => k !== "radius" && !k.startsWith("chart-"));

describe.each([
  ["light", light],
  ["dark", dark],
])("platform %s tokens", (_scheme, t) => {
  const text: [string, string][] = [
    ["foreground", "background"],
    ["card-foreground", "card"],
    ["popover-foreground", "popover"],
    ["primary-foreground", "primary"],
    ["secondary-foreground", "secondary"],
    ["accent-foreground", "accent"],
    ["foreground", "muted"],
    ["muted-foreground", "background"],
    ["muted-foreground", "card"],
    ["muted-foreground", "muted"],
    ["destructive", "background"],
    ["destructive", "card"],
    ["destructive-foreground", "destructive"],
    ["success-foreground", "success"],
    ["warning-foreground", "warning"],
    ["sidebar-foreground", "sidebar"],
    ["sidebar-accent-foreground", "sidebar-accent"],
  ];
  it.each(text)("%s on %s is at least 4.5:1", (fg, bg) => {
    expect(contrastRatio(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });

  // WCAG 1.4.11: input borders and focus rings need 3:1 against what they sit on.
  const ui: [string, string][] = [
    ["input", "background"],
    ["input", "card"],
    ["input", "popover"],
    ["ring", "background"],
    ["ring", "card"],
    ["sidebar-ring", "sidebar"],
  ];
  it.each(ui)("%s against %s is at least 3:1", (fg, bg) => {
    expect(contrastRatio(t[fg], t[bg])).toBeGreaterThanOrEqual(3);
  });
});

describe("platform theme", () => {
  it("keeps the primary button neutral: navy on light, white on navy", () => {
    expect([light.primary, light["primary-foreground"]]).toEqual(["#061a26", "#ffffff"]);
    expect([dark.primary, dark["primary-foreground"]]).toEqual(["#ffffff", "#061a26"]);
  });

  it("uses Signal Aqua on dark only, Deep Teal in its place on light", () => {
    // The sidebar tokens describe the navy sidebar, so aqua is allowed there.
    for (const [name, value] of Object.entries(light)) {
      if (!name.startsWith("sidebar")) expect(value, name).not.toBe("#6be6d6");
    }
    expect(light.ring).toBe("#0b6a68");
    expect(dark.ring).toBe("#6be6d6");
  });

  it("defines every colour token, so no neutral value leaks onto a platform screen", () => {
    expect(colourTokens(light).sort()).toEqual(colourTokens(tenantLight).sort());
    // The navy surfaces carry `.dark`; anything platform-dark misses would show
    // the neutral dark value there.
    expect(colourTokens(dark).sort()).toEqual(colourTokens(tenantDark).sort());
  });

  it("leaves TechFlow's colours off the tenant tokens (D13)", () => {
    for (const value of [...Object.values(tenantLight), ...Object.values(tenantDark)]) {
      expect(BRAND).not.toContain(value.toLowerCase());
    }
  });
});
