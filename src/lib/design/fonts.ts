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

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--tenant-font-inter",
});

const roboto = Roboto({
  subsets: ["latin"],
  display: "swap",
  variable: "--tenant-font-roboto",
  weight: ["400", "500", "700"],
});

const openSans = Open_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--tenant-font-open-sans",
});

const lato = Lato({
  subsets: ["latin"],
  display: "swap",
  variable: "--tenant-font-lato",
  weight: ["400", "700"],
});

const montserrat = Montserrat({
  subsets: ["latin"],
  display: "swap",
  variable: "--tenant-font-montserrat",
});

const poppins = Poppins({
  subsets: ["latin"],
  display: "swap",
  variable: "--tenant-font-poppins",
  weight: ["400", "500", "600", "700"],
});

const sourceSans3 = Source_Sans_3({
  subsets: ["latin"],
  display: "swap",
  variable: "--tenant-font-source-sans",
});

const merriweather = Merriweather({
  subsets: ["latin"],
  display: "swap",
  variable: "--tenant-font-merriweather",
  weight: ["400", "700"],
});

export const tenantFontLoaders = {
  Inter: inter,
  Roboto: roboto,
  "Open Sans": openSans,
  Lato: lato,
  Montserrat: montserrat,
  Poppins: poppins,
  "Source Sans 3": sourceSans3,
  Merriweather: merriweather,
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
