import Image from "next/image";

import { cn } from "@/lib/utils";

const TILE_PADDING = 4; // p-1

interface BusinessLogoProps {
  src: string;
  /** Empty when the business's name is written beside the logo. */
  alt?: string;
  /** The largest box the logo may fill, in CSS pixels. */
  maxWidth: number;
  maxHeight: number;
  /**
   * Sets the logo on a white rounded tile, for dark or brand-coloured surfaces
   * where a dark logo would disappear. White is also what invoices, PDFs and
   * emails show it on.
   */
  tile?: boolean;
  /** Classes for the outermost element: the tile, or the image itself. */
  className?: string;
}

/**
 * A business's logo at its own shape (G-06): scaled down to fit within
 * maxWidth × maxHeight, never cropped or stretched, so a wide wordmark stays
 * wide and a square mark stays square. A tile is never narrower than it is
 * tall, so square and tall logos sit in a square.
 */
export function BusinessLogo({
  src,
  alt = "",
  maxWidth,
  maxHeight,
  tile = false,
  className,
}: BusinessLogoProps) {
  const image = (
    <Image
      src={src}
      alt={alt}
      width={maxWidth}
      height={maxHeight}
      unoptimized
      className={cn("h-auto w-auto object-contain", !tile && className)}
      style={{ maxWidth, maxHeight }}
    />
  );
  if (!tile) return image;

  const side = maxHeight + 2 * TILE_PADDING;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-white p-1",
        className,
      )}
      style={{ height: side, minWidth: side }}
    >
      {image}
    </span>
  );
}
