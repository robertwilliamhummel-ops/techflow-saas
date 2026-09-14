import Image from "next/image";

import { computeForeground } from "@/lib/design/contrast";
import { businessInitial, portalAccent } from "@/lib/portal/portalHome";

interface BusinessMarkProps {
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
}

// A business's logo, or its initial on its brand colour. The portal shell stays
// neutral; branding comes from each document's snapshot (blueprint Phase 3,
// CustomerPortalContext), so three businesses show three marks.
export function BusinessMark({ name, logoUrl, primaryColor }: BusinessMarkProps) {
  if (logoUrl) {
    return (
      <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white p-1 ring-1 ring-foreground/10">
        <Image
          src={logoUrl}
          alt=""
          width={40}
          height={40}
          className="max-h-full max-w-full object-contain"
          unoptimized
        />
      </span>
    );
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
