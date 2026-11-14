// The business's font on its customer-facing pages (G-04): the pay pages, the
// portal invoice and quote pages, and the branded portal login. The dashboard
// never imports this module, so it keeps the platform font and ships none of
// this CSS.
//
// next/font self-hosts the files at build time; browsers never contact Google.
// Each loader sets --font-sans, which Tailwind's font-sans and font-heading
// read, so tenantFontClass() on a wrapper retypes everything inside it (card
// and alert titles too) while font-mono stays monospace. preload is off: the
// family is only known at runtime, so preloading would fetch all seven on
// every visit, whereas a browser downloads an @font-face file only for text
// that uses it, so a page fetches just its business's family. Inter, the
// platform font, comes from the root layout.

import {
  Lato,
  Merriweather,
  Montserrat,
  Open_Sans,
  Poppins,
  Roboto,
  Source_Sans_3,
} from "next/font/google";

import { DEFAULT_TENANT_FONT, resolveTenantFont, type TenantFont } from "@/lib/design/fonts";

// Variable families need no weights; Lato and Poppins come in static weights
// only, so they list the ones the pages use (Lato has no 500 or 600).
const roboto = Roboto({ subsets: ["latin"], display: "swap", preload: false, variable: "--font-sans" });
const openSans = Open_Sans({ subsets: ["latin"], display: "swap", preload: false, variable: "--font-sans" });
const lato = Lato({
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
  preload: false,
  variable: "--font-sans",
});
const montserrat = Montserrat({ subsets: ["latin"], display: "swap", preload: false, variable: "--font-sans" });
const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  preload: false,
  variable: "--font-sans",
});
const sourceSans3 = Source_Sans_3({ subsets: ["latin"], display: "swap", preload: false, variable: "--font-sans" });
const merriweather = Merriweather({ subsets: ["latin"], display: "swap", preload: false, variable: "--font-sans" });

const LOADERS: Record<Exclude<TenantFont, typeof DEFAULT_TENANT_FONT>, { variable: string }> = {
  Roboto: roboto,
  "Open Sans": openSans,
  Lato: lato,
  Montserrat: montserrat,
  Poppins: poppins,
  "Source Sans 3": sourceSans3,
  Merriweather: merriweather,
};

/**
 * Classes that put a wrapper's text in the business's font; empty for Inter
 * and for any name that isn't on the list, which keep the platform font.
 */
export function tenantFontClass(fontFamily: unknown): string {
  const font = resolveTenantFont(fontFamily);
  return font === DEFAULT_TENANT_FONT ? "" : `${LOADERS[font].variable} font-sans`;
}
