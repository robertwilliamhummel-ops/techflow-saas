// TechFlow's own pages — sign-in, sign-up, the owner dashboard, accepting an
// invitation — carry TechFlow's tab icon and title (G-03). Pages a business's
// customers see set their own (src/lib/tenant/tabIcon.ts).

import type { Metadata } from "next";
import { headers } from "next/headers";

import { NEUTRAL_TAB_ICON } from "@/lib/tenant/tabIcon";

export const PLATFORM_ICONS = {
  icon: [
    { url: "/brand/techflow-favicon.svg", type: "image/svg+xml" },
    { url: "/brand/techflow-favicon-32.png", sizes: "32x32", type: "image/png" },
    { url: "/brand/techflow-favicon-16.png", sizes: "16x16", type: "image/png" },
  ],
  apple: { url: "/brand/techflow-icon-192.png", sizes: "192x192", type: "image/png" },
} satisfies Metadata["icons"];

/**
 * Whether TechFlow's branding may show. Not on a business's custom domain:
 * src/proxy.ts sets x-tenant-id only there, and strips any client value. Its
 * pages stay neutral there, as D13 keeps TechFlow off the business's surfaces.
 */
export async function showPlatformBrand(): Promise<boolean> {
  return !(await headers()).has("x-tenant-id");
}

/** Title and icons for a platform route group; pages add their own titles. */
export async function platformMetadata(section?: string): Promise<Metadata> {
  return {
    title: {
      template: "%s · TechFlow",
      default: section ? `${section} · TechFlow` : "TechFlow",
    },
    icons: (await showPlatformBrand()) ? PLATFORM_ICONS : { icon: NEUTRAL_TAB_ICON },
  };
}
