// D15 — a logo with a see-through background is put on a solid white tile when
// it's uploaded on Settings → Branding.
//
// Gmail's phone apps darken an email's background in dark mode but never touch
// its images, so a transparent PNG with dark lettering disappears (dark on
// dark). CSS backgrounds and table bgcolor get recoloured too; the only fix that
// holds in every client is a solid background inside the image itself. Every
// surface that shows the logo is already white (invoices, PDFs, the pay page
// and portal tiles, light-mode email), so the tile only shows in dark mode.
//
// These helpers are pure so vitest can run them without a DOM; prepareLogo.ts
// is the canvas wrapper that feeds them pixels and draws the tile.

/**
 * The most a stored logo may weigh: creating an invoice refuses a bigger one
 * (LOGO_MAX_BYTES in functions/src/shared/logo.ts), so a tile that comes out
 * heavier is drawn smaller until it fits.
 */
export const LOGO_MAX_BYTES = 500 * 1024;

/**
 * White margin around the artwork, as a share of its shorter side (the height
 * of a wide logo). Emails and PDFs fit the logo in 200×60, where the margin is
 * invisible in light mode but still takes room: at 10% a 4:1 wordmark gives up
 * about 5% of its width there and keeps about 5 px of white on every side in a
 * dark inbox.
 */
export const TILE_MARGIN_RATIO = 0.1;

/** Longest side of a tile, in pixels: six times the 200 px emails and PDFs show. */
export const TILE_MAX_SIDE = 1200;

/** A pixel at least this opaque lets nothing through (allows for encoder rounding). */
export const OPAQUE_ALPHA = 250;

/** Pixels fainter than this (under 3% coverage) count as empty when trimming. */
export const CONTENT_ALPHA = 8;

/** Ink with less contrast than this against white barely shows on a white page. */
export const VISIBLE_ON_WHITE_CONTRAST = 1.5;

/**
 * A logo is very light when less than this share of its ink shows on white:
 * artwork made for dark backgrounds. White lettering beside a coloured mark
 * still counts — TechFlow's own on-dark logo shows 39% of its ink on white,
 * its light-background version 100% — and a tile would only hide it in a dark
 * inbox too.
 */
export const VERY_LIGHT_SHARE = 0.5;

/** RGBA bytes row by row, as canvas getImageData returns them. */
export interface Pixels {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface LogoAnalysis {
  /** Some pixel lets the background through. */
  transparent: boolean;
  /** The artwork's bounding box (pixels at CONTENT_ALPHA or more); null when blank. */
  bounds: Box | null;
  /** Share of the ink, weighted by opacity, that shows on white; 0 when blank. */
  visibleShare: number;
}

export type LogoPlan =
  /** Upload the file as it is. */
  | { action: "keep"; veryLight: boolean }
  /** Draw the artwork (`bounds`) on a white tile and upload that as a PNG. */
  | { action: "tile"; bounds: Box }
  /** An opaque SVG: rasterize it to PNG as it is. */
  | { action: "rasterize" };

// WCAG 2 linearised sRGB channel, the formula src/lib/design/contrast.ts uses.
const LINEAR = Array.from({ length: 256 }, (_, channel) => {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
});

/** WCAG relative luminance of an 8-bit sRGB colour. */
export function pixelLuminance(r: number, g: number, b: number): number {
  return 0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b];
}

// Contrast with white is 1.05 / (L + 0.05), so ink shows when L is at most this.
const VISIBLE_MAX_LUMINANCE = 1.05 / VISIBLE_ON_WHITE_CONTRAST - 0.05;

/** One pass over the pixels: transparency, the artwork's bounds, and how much of it shows on white. */
export function analyzeLogo({ data, width, height }: Pixels): LogoAnalysis {
  let transparent = false;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let ink = 0;
  let visibleInk = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const alpha = data[i + 3];
      if (alpha < OPAQUE_ALPHA) transparent = true;
      if (alpha === 0) continue;
      ink += alpha;
      if (pixelLuminance(data[i], data[i + 1], data[i + 2]) <= VISIBLE_MAX_LUMINANCE) {
        visibleInk += alpha;
      }
      if (alpha >= CONTENT_ALPHA) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    transparent,
    bounds:
      maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    visibleShare: ink === 0 ? 0 : visibleInk / ink,
  };
}

/** What to upload, given the analysis and whether the file is an SVG. */
export function planLogo(analysis: LogoAnalysis, vector: boolean): LogoPlan {
  if (!analysis.transparent) {
    return vector ? { action: "rasterize" } : { action: "keep", veryLight: false };
  }
  // White artwork made for dark backgrounds can't show on white whatever we do,
  // and a white tile would hide it in dark mode too, so it's kept as it is and
  // the page warns instead.
  if (!analysis.bounds || analysis.visibleShare < VERY_LIGHT_SHARE) {
    return { action: "keep", veryLight: true };
  }
  return { action: "tile", bounds: analysis.bounds };
}

/**
 * Maps a box measured on a copy drawn at `measured` size back to the image's
 * own `natural` units. Raster boxes widen to whole pixels, so the artwork is
 * copied pixel for pixel; SVG boxes keep their fractions.
 */
export function toSourceBox(
  box: Box,
  measured: Size,
  natural: Size,
  wholePixels: boolean,
): Box {
  const sx = natural.width / measured.width;
  const sy = natural.height / measured.height;
  let x0 = box.x * sx;
  let y0 = box.y * sy;
  let x1 = (box.x + box.width) * sx;
  let y1 = (box.y + box.height) * sy;
  if (wholePixels) {
    x0 = Math.floor(x0);
    y0 = Math.floor(y0);
    x1 = Math.ceil(x1);
    y1 = Math.ceil(y1);
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(natural.width, x1);
  y1 = Math.min(natural.height, y1);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export interface TileLayout {
  /** Canvas pixels per source unit; 1 copies the artwork's own pixels. */
  scale: number;
  /** Canvas size, in pixels. */
  width: number;
  height: number;
  /** The artwork in the source image… */
  source: Box;
  /** …and where it's drawn on the canvas. */
  dest: Box;
}

export interface TileOptions {
  marginRatio?: number;
  maxSide?: number;
  /** Allow scaling up — only for SVG, which stays sharp at any size. */
  upscale?: boolean;
}

// Absorbs float error before flooring (0.1 × 333 is 33.300000000000004).
const EPSILON = 1e-6;

/**
 * The tile around `artwork`: a margin of `marginRatio` × its shorter side on
 * every side, at native size unless the tile's longest side would pass
 * `maxSide`. Sizes are floored and the margin is at least 1 px, and the canvas
 * never passes `maxSide`.
 */
export function tileLayout(
  artwork: Box,
  {
    marginRatio = TILE_MARGIN_RATIO,
    maxSide = TILE_MAX_SIDE,
    upscale = false,
  }: TileOptions = {},
): TileLayout {
  const margin = marginRatio * Math.min(artwork.width, artwork.height);
  const fit = maxSide / (Math.max(artwork.width, artwork.height) + 2 * margin);
  const scale = upscale ? fit : Math.min(1, fit);
  const pad = marginRatio > 0 ? Math.max(1, Math.floor(margin * scale + EPSILON)) : 0;
  // Room inside the margins; only a sliver-thin logo at a tiny maxSide needs it.
  const room = Math.max(1, maxSide - 2 * pad);
  const width = Math.min(room, Math.max(1, Math.floor(artwork.width * scale + EPSILON)));
  const height = Math.min(room, Math.max(1, Math.floor(artwork.height * scale + EPSILON)));
  return {
    scale,
    width: width + 2 * pad,
    height: height + 2 * pad,
    source: artwork,
    dest: { x: pad, y: pad, width, height },
  };
}

/**
 * The longest side to try next after a tile `longSide` pixels long encoded to
 * `bytes`. PNG size grows about with pixel count, so the side shrinks by the
 * square root of the overshoot, with 10% to spare.
 */
export function nextMaxSide(
  longSide: number,
  bytes: number,
  limit: number = LOGO_MAX_BYTES,
): number {
  if (bytes <= limit) return longSide;
  return Math.max(1, Math.floor(longSide * Math.sqrt(limit / bytes) * 0.9));
}
