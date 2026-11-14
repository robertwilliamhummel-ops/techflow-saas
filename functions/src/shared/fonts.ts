// The fonts a business can choose in Settings → Branding (blueprint, Phase 1.5
// "Font system": free-text fonts are not allowed). updateTenantBranding accepts
// only these, and the customer views name the one a document renders in.
//
// Identical copies: src/lib/design/fonts.ts (app) and pdf-service/src/fonts.ts,
// pinned together by src/lib/__tests__/fonts.test.ts.
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
export const DEFAULT_TENANT_FONT: TenantFont = "Inter";

export function isTenantFont(value: unknown): value is TenantFont {
  return typeof value === "string" && (TENANT_FONTS as readonly string[]).includes(value);
}

/** The font a document renders in: the snapshot's, else the platform font. */
export function resolveTenantFont(value: unknown): TenantFont {
  return isTenantFont(value) ? value : DEFAULT_TENANT_FONT;
}
