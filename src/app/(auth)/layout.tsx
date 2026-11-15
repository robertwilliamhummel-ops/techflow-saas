import type { Metadata } from "next";
import Image from "next/image";

import { PlatformTheme } from "@/components/theme/PlatformTheme";
import { platformMetadata, showPlatformBrand } from "@/lib/platformMetadata";

export function generateMetadata(): Promise<Metadata> {
  return platformMetadata();
}

// The full logo is 4:1 (504 × 126); at 48 px tall it is well above the brand
// guide's 120 px minimum width. The on-light file on light pages, on-dark on
// dark ones — never the other way round (BRAND_GUIDE.md).
const LOGO = { width: 192, height: 48 };
const LOGO_ALT = "TechFlow Solutions";
const FRAME = "flex min-h-screen items-center justify-center bg-background px-4 py-12 text-foreground";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  // On a business's own domain these pages carry no TechFlow branding at all —
  // neither the logo (G-03) nor the navy theme (D17) — per D13.
  const brand = await showPlatformBrand();
  const content = (
    <div className="w-full max-w-sm">
      {brand ? (
        <div className="mb-8 flex justify-center">
          <Image
            src="/brand/techflow-logo-full-on-light.svg"
            alt={LOGO_ALT}
            {...LOGO}
            unoptimized
            className="h-12 w-auto dark:hidden"
          />
          <Image
            src="/brand/techflow-logo-full-on-dark.svg"
            alt={LOGO_ALT}
            {...LOGO}
            unoptimized
            className="hidden h-12 w-auto dark:block"
          />
        </div>
      ) : null}
      {children}
    </div>
  );
  return brand ? (
    <PlatformTheme className={FRAME}>{content}</PlatformTheme>
  ) : (
    <div className={FRAME}>{content}</div>
  );
}
