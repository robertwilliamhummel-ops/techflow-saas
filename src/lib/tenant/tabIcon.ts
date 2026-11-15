// Browser-tab icons for pages a business's customers see: the pay page, the
// portal and its sign-in (G-03). They never fall back to TechFlow's icon (D13):
// a business without a favicon gets its initial on its brand colour — the
// portal's mark for a business without a logo — and a page that doesn't know
// the business gets a neutral document icon.

import { computeForeground } from "@/lib/design/contrast";
import { portalAccent } from "@/lib/portal/portalHome";

/** A plain document on slate, for pages that don't know the business. */
export const NEUTRAL_TAB_ICON = "/icons/neutral-tab.svg";

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** The business's initial on its brand colour, as an SVG data URL. */
export function initialTabIcon(name: string, primaryColor: string | null): string {
  // The first character, not the first UTF-16 unit: a name can start with an
  // emoji, and half of one can't be encoded.
  const initial = (Array.from(name.trim())[0] ?? "?").toUpperCase();
  const accent = portalAccent(primaryColor);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="${accent}"/>` +
    `<text x="16" y="22.5" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" ` +
    `font-size="19" font-weight="700" fill="${computeForeground(accent)}">` +
    `${initial.replace(/[&<>"']/g, (c) => XML_ESCAPES[c])}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** The business's own favicon, else its initial. */
export function businessTabIcon(branding: {
  name: string;
  faviconUrl: string | null;
  primaryColor: string | null;
}): string {
  return branding.faviconUrl ?? initialTabIcon(branding.name, branding.primaryColor);
}
