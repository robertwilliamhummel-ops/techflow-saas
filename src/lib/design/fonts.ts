// The fonts a business can choose in Settings → Branding (blueprint, Phase 1.5
// "Font system"). Its customer-facing pages and PDFs use the chosen one; the
// dashboard always uses the platform font, Inter.
//
// Plain data, so the dashboard and tests can import it without loading any
// font: the customer-facing pages load the families with next/font in
// src/lib/design/tenantFontClass.ts. Identical lists in
// functions/src/shared/fonts.ts (updateTenantBranding accepts only these) and
// pdf-service/src/fonts.ts (embeds the chosen one in PDFs), pinned together by
// src/lib/__tests__/fonts.test.ts.
export const TENANT_FONTS = [
  "Inter",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Poppins",
  "Source Sans 3",
  "Merriweather",
] as const;

export type TenantFont = (typeof TENANT_FONTS)[number];

/** The platform font, and the font for any name that isn't on the list. */
export const DEFAULT_TENANT_FONT = "Inter" satisfies TenantFont;

export function isTenantFont(value: unknown): value is TenantFont {
  return typeof value === "string" && (TENANT_FONTS as readonly string[]).includes(value);
}

/** The font a page renders in: the business's choice, else the platform font. */
export function resolveTenantFont(value: unknown): TenantFont {
  return isTenantFont(value) ? value : DEFAULT_TENANT_FONT;
}
