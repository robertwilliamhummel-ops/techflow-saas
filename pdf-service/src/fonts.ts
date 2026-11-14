// The fonts a business can choose in Settings → Branding (blueprint, Phase 1.5
// "Font system"), and the @font-face rules that put the chosen one in its PDFs.
//
// Mirrors src/lib/design/fonts.ts (app) and functions/src/shared/fonts.ts; the
// app's src/lib/__tests__/fonts.test.ts pins the three lists together.
//
// Chrome in the image has none of these installed, and a render loads nothing
// over the network (U-02), so each family is vendored in src/fonts/<dir>/ with
// its SIL Open Font License (OFL.txt, from github.com/google/fonts): the Latin
// subset of the regular (400) and bold (700) static instances, as WOFF2 from
// Fontsource 5.3 (Google Fonts' files). Static, not variable: Chrome's PDF
// backend embeds a variable font as Type 3 glyphs rather than a TrueType
// subset. Only the chosen family goes into the page, as data: URLs, which the
// page CSP allows (font-src data:). The templates' 600 renders with the 700
// face; characters outside the Latin subset fall back to the image's fonts.

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/** The platform font, for snapshots that name no font from the list. */
export const DEFAULT_TENANT_FONT: TenantFont = "Inter";

const FONT_FILES: Record<TenantFont, { dir: string; serif: boolean }> = {
  Inter: { dir: "inter", serif: false },
  Roboto: { dir: "roboto", serif: false },
  "Open Sans": { dir: "open-sans", serif: false },
  Lato: { dir: "lato", serif: false },
  Montserrat: { dir: "montserrat", serif: false },
  Poppins: { dir: "poppins", serif: false },
  "Source Sans 3": { dir: "source-sans-3", serif: false },
  Merriweather: { dir: "merriweather", serif: true },
};

export const FONT_WEIGHTS = [400, 700] as const;

// src/fonts under the tests, dist/fonts in the image (the Dockerfile copies it,
// as it does the templates).
export const FONT_DIR = join(__dirname, "fonts");

/** The family a snapshot names, or null for anything not on the list. */
export function sanitizeFont(value: unknown): TenantFont | null {
  return typeof value === "string" &&
    (TENANT_FONTS as readonly string[]).includes(value)
    ? (value as TenantFont)
    : null;
}

/** The family a PDF renders in: the snapshot's, else the platform font. */
export function resolveFont(value: unknown): TenantFont {
  return sanitizeFont(value) ?? DEFAULT_TENANT_FONT;
}

/** font-family for the body: the family, then the same kind of system face. */
export function fontStack(font: TenantFont): string {
  return FONT_FILES[font].serif
    ? `'${font}', Georgia, serif`
    : `'${font}', system-ui, sans-serif`;
}

export function fontFilePath(font: TenantFont, weight: (typeof FONT_WEIGHTS)[number]): string {
  return join(FONT_DIR, FONT_FILES[font].dir, `latin-${weight}.woff2`);
}

export function fontLicensePath(font: TenantFont): string {
  return join(FONT_DIR, FONT_FILES[font].dir, "OFL.txt");
}

const fontFaceCache = new Map<TenantFont, string>();

/**
 * @font-face rules for one family, its files inlined as data: URLs. Built only
 * from the list above and the vendored files — never from snapshot text — so
 * the template can write it into its <style> block unescaped. A missing file
 * throws, failing the render rather than printing in a fallback font.
 */
export function fontFaceCss(font: TenantFont): string {
  const cached = fontFaceCache.get(font);
  if (cached) return cached;
  const css = FONT_WEIGHTS.map((weight) => {
    const data = readFileSync(fontFilePath(font, weight)).toString("base64");
    return (
      `@font-face{font-family:'${font}';font-style:normal;font-weight:${weight};` +
      `font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2');}`
    );
  }).join("\n");
  fontFaceCache.set(font, css);
  return css;
}
