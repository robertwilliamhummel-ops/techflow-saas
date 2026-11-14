import { BusinessLogo } from "@/components/branding/BusinessLogo";
import { computeForeground } from "@/lib/design/contrast";
import { businessInitial, portalAccent } from "@/lib/portal/portalHome";

interface BusinessMarkProps {
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
  /** `lg` for a document's header; list rows keep the compact mark. */
  size?: "sm" | "lg";
}

// The logo's largest box: a wide logo keeps its shape, up to this width.
const LOGO_BOX = {
  sm: { maxWidth: 80, maxHeight: 32 },
  lg: { maxWidth: 160, maxHeight: 40 },
} as const;

// A business's logo, or its initial on its brand colour. The portal shell stays
// neutral; branding comes from each document's snapshot (blueprint Phase 3,
// CustomerPortalContext), so three businesses show three marks.
export function BusinessMark({ name, logoUrl, primaryColor, size = "sm" }: BusinessMarkProps) {
  if (logoUrl) {
    return <BusinessLogo src={logoUrl} {...LOGO_BOX[size]} tile className="ring-1 ring-foreground/10" />;
  }

  const accent = portalAccent(primaryColor);
  return (
    <span
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center rounded-md text-base font-semibold"
      style={{ backgroundColor: accent, color: computeForeground(accent) }}
    >
      {businessInitial(name)}
    </span>
  );
}
