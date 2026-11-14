import Image from "next/image";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

// D15 — the stored logo where customers see it: on white (invoices, PDFs, the
// pay page, light-mode email) and in an email app's dark mode, which darkens
// the email around the logo but never the logo itself. Sized like the email
// and PDF headers, at most 200×60.
export function LogoPreviews({ src, veryLight }: { src: string; veryLight: boolean }) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <LogoSurface src={src} label="On your invoices" className="bg-white" />
        <LogoSurface src={src} label="In a dark-mode inbox" className="bg-black" />
      </div>
      <p className="text-xs text-muted-foreground">
        A logo with a see-through background is placed on a white tile, so it stays visible when
        an email app switches to dark mode.
      </p>
      {veryLight ? (
        <Alert className="border-warning/40 text-warning">
          <TriangleAlert aria-hidden />
          <AlertDescription>
            This logo is very light and won&apos;t show on white invoices. Upload a version made for
            light backgrounds.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function LogoSurface({
  src,
  label,
  className,
}: {
  src: string;
  label: string;
  className: string;
}) {
  return (
    <figure className="grid gap-1.5">
      <div
        className={cn("flex h-24 items-center rounded-md px-6 ring-1 ring-foreground/10", className)}
      >
        <Image
          src={src}
          alt={`Your logo ${label.toLowerCase()}`}
          width={200}
          height={60}
          className="h-auto max-h-[60px] w-auto max-w-[200px]"
          unoptimized
        />
      </div>
      <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
    </figure>
  );
}
