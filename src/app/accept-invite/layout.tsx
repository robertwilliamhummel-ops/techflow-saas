import type { Metadata } from "next";

import { PlatformTheme } from "@/components/theme/PlatformTheme";
import { platformMetadata, showPlatformBrand } from "@/lib/platformMetadata";

export function generateMetadata(): Promise<Metadata> {
  return platformMetadata("Join your team");
}

// Accepting a staff invitation is a platform screen (D17), like sign-in —
// except on a business's custom domain, which carries no TechFlow branding (D13).
export default async function AcceptInviteLayout({ children }: { children: React.ReactNode }) {
  return (await showPlatformBrand()) ? <PlatformTheme>{children}</PlatformTheme> : children;
}
