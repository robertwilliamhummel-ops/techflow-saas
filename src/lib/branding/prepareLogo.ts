"use client";

// D15 — the browser side of the white logo tile: decode the upload, measure it,
// and draw the tile. The rules live in logoTile.ts.

import {
  LOGO_MAX_BYTES,
  TILE_MARGIN_RATIO,
  TILE_MAX_SIDE,
  analyzeLogo,
  nextMaxSide,
  planLogo,
  tileLayout,
  toSourceBox,
  type Box,
  type LogoPlan,
  type Pixels,
  type Size,
  type TileOptions,
} from "./logoTile";

/** Bigger rasters are measured on a scaled-down copy, to bound memory. */
const MEASURE_MAX_SIDE = 4096;

const MAX_ENCODE_ATTEMPTS = 5;

export interface PreparedLogo {
  /** What to upload: the original file, or a solid PNG of the logo on its tile. */
  file: File;
  action: LogoPlan["action"];
  /** Too light to see on white invoices (the page warns). */
  veryLight: boolean;
}

/**
 * Turns a logo upload into what Storage should hold (D15). A PNG or WebP with
 * transparency, or an SVG, becomes a solid PNG with the artwork on a white tile
 * — at its own pixels unless the tile would pass TILE_MAX_SIDE. Opaque images,
 * JPEG, very light artwork, and SVGs this browser can't rasterize upload as
 * they are.
 */
export async function prepareLogo(file: File): Promise<PreparedLogo> {
  const keep = (veryLight = false): PreparedLogo => ({ file, action: "keep", veryLight });
  const vector = file.type === "image/svg+xml";
  // JPEG has no alpha channel; other types are refused by uploadBrandingAsset.
  if (!vector && file.type !== "image/png" && file.type !== "image/webp") return keep();

  const url = URL.createObjectURL(file);
  try {
    const image = await decodeImage(url);
    const natural = { width: image.naturalWidth, height: image.naturalHeight };
    // Some browsers report no size for an SVG without width/height attributes.
    if (natural.width < 1 || natural.height < 1) return keep();

    // SVGs are measured at the size they'll be drawn, rasters at their own.
    const longest = Math.max(natural.width, natural.height);
    const measureScale = vector ? TILE_MAX_SIDE / longest : Math.min(1, MEASURE_MAX_SIDE / longest);
    const pixels = readPixels(image, natural, measureScale);
    // An SVG with a <foreignObject> taints the canvas, so it can't be read.
    if (!pixels) return keep();

    const plan = planLogo(analyzeLogo(pixels), vector);
    if (plan.action === "keep") return keep(plan.veryLight);
    const blob =
      plan.action === "tile"
        ? await encodeTile(image, toSourceBox(plan.bounds, pixels, natural, !vector), {
            marginRatio: TILE_MARGIN_RATIO,
            upscale: vector,
          })
        : await encodeTile(image, { x: 0, y: 0, ...natural }, { marginRatio: 0, upscale: true });
    return {
      file: new File([blob], pngName(file.name), { type: "image/png" }),
      action: plan.action,
      veryLight: false,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decodeImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    throw new Error("That image couldn't be opened. Upload a PNG, JPG, WebP, or SVG file.");
  }
  return image;
}

function canvas2d(
  width: number,
  height: number,
  settings: CanvasRenderingContext2DSettings,
): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", settings);
  if (!ctx) throw new Error("This browser can't prepare the logo. Try another browser.");
  return ctx;
}

function readPixels(image: HTMLImageElement, natural: Size, scale: number): Pixels | null {
  const width = Math.max(1, Math.round(natural.width * scale));
  const height = Math.max(1, Math.round(natural.height * scale));
  const ctx = canvas2d(width, height, { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);
  try {
    return { data: ctx.getImageData(0, 0, width, height).data, width, height };
  } catch {
    return null;
  }
}

function drawTile(image: HTMLImageElement, artwork: Box, options: TileOptions): HTMLCanvasElement {
  const { width, height, source, dest } = tileLayout(artwork, options);
  // An opaque canvas encodes as an RGB PNG with no alpha channel at all.
  const ctx = canvas2d(width, height, { alpha: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    image,
    source.x,
    source.y,
    source.width,
    source.height,
    dest.x,
    dest.y,
    dest.width,
    dest.height,
  );
  return ctx.canvas;
}

async function encodeTile(
  image: HTMLImageElement,
  artwork: Box,
  options: TileOptions,
): Promise<Blob> {
  let maxSide = TILE_MAX_SIDE;
  for (let attempt = 0; attempt < MAX_ENCODE_ATTEMPTS; attempt++) {
    const canvas = drawTile(image, artwork, { ...options, maxSide });
    const blob = await pngBlob(canvas);
    if (blob.size <= LOGO_MAX_BYTES) return blob;
    maxSide = nextMaxSide(Math.max(canvas.width, canvas.height), blob.size);
  }
  throw new Error(
    "This logo has too much detail to store under 500 KB. Upload a simpler or smaller version.",
  );
}

function pngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Couldn't prepare the logo. Try again."))),
      "image/png",
    ),
  );
}

function pngName(name: string): string {
  return `${name.replace(/\.[^.]*$/, "") || "logo"}.png`;
}
