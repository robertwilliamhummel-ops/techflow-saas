import {
  Inter,
  Roboto,
  Open_Sans,
  Lato,
  Montserrat,
  Poppins,
  Source_Sans_3,
  Merriweather,
} from "next/font/google";

export const tenantFontLoaders = {
  Inter: Inter({
    subsets: ["latin"],
    display: "swap",
    variable: "--tenant-font-inter",
  }),
  Roboto: Roboto({
    subsets: ["latin"],
    display: "swap",
    variable: "--tenant-font-roboto",
    weight: ["400", "500", "700"],
  }),
  "Open Sans": Open_Sans({
    subsets: ["latin"],
    display: "swap",
    variable: "--tenant-font-open-sans",
  }),
  Lato: Lato({
    subsets: ["latin"],
    display: "swap",
    variable: "--tenant-font-lato",
    weight: ["400", "700"],
  }),
  Montserrat: Montserrat({
    subsets: ["latin"],
    display: "swap",
    variable: "--tenant-font-montserrat",
  }),
  Poppins: Poppins({
    subsets: ["latin"],
    display: "swap",
    variable: "--tenant-font-poppins",
    weight: ["400", "500", "600", "700"],
  }),
  "Source Sans 3": Source_Sans_3({
    subsets: ["latin"],
    display: "swap",
    variable: "--tenant-font-source-sans",
  }),
  Merriweather: Merriweather({
    subsets: ["latin"],
    display: "swap",
    variable: "--tenant-font-merriweather",
    weight: ["400", "700"],
  }),
} as const;

export type TenantFontKey = keyof typeof tenantFontLoaders;

export const TENANT_FONTS: TenantFontKey[] = [
  "Inter",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Poppins",
  "Source Sans 3",
  "Merriweather",
];

export function resolveTenantFont(
  fontFamily: string | null | undefined,
): TenantFontKey {
  if (fontFamily && fontFamily in tenantFontLoaders) {
    return fontFamily as TenantFontKey;
  }
  return "Inter";
}
