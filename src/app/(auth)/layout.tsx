import type { Metadata } from "next";
import Image from "next/image";

import { platformMetadata, showPlatformBrand } from "@/lib/platformMetadata";

export function generateMetadata(): Promise<Metadata> {
  return platformMetadata();
}

// The full logo is 4:1 (504 × 126); at 48 px tall it is well above the brand
// guide's 120 px minimum width. The on-light file on light pages, on-dark on
// dark ones — never the other way round (BRAND_GUIDE.md).
const LOGO = { width: 192, height: 48 };
const LOGO_ALT = "TechFlow Solutions";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const brand = await showPlatformBrand();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12 text-foreground">
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
    </div>
  );
}
