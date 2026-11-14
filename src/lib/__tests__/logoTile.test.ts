import { describe, expect, it } from "vitest";
import {
  LOGO_MAX_BYTES,
  TILE_MARGIN_RATIO,
  TILE_MAX_SIDE,
  VISIBLE_ON_WHITE_CONTRAST,
  analyzeLogo,
  nextMaxSide,
  pixelLuminance,
  planLogo,
  tileLayout,
  toSourceBox,
  type LogoAnalysis,
  type Pixels,
} from "../branding/logoTile";
import { contrastRatio, relativeLuminance } from "../design/contrast";
import { PDF_LOGO_MAX_BYTES } from "../pdf/logo";

type Rgba = [number, number, number, number];

const CLEAR: Rgba = [0, 0, 0, 0];
const INK: Rgba = [17, 24, 39, 255];
const WHITE: Rgba = [255, 255, 255, 255];

function pixels(width: number, height: number, at: (x: number, y: number) => Rgba): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(at(x, y), (y * width + x) * 4);
  }
  return { data, width, height };
}

function hex([r, g, b]: Rgba): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

// A 10×6 canvas with `fill` in the box x 2–7, y 1–3 and nothing around it.
function artwork(fill: Rgba): Pixels {
  return pixels(10, 6, (x, y) => (x >= 2 && x <= 7 && y >= 1 && y <= 3 ? fill : CLEAR));
}

describe("pixelLuminance", () => {
  it("matches the app's WCAG luminance", () => {
    for (const colour of [INK, WHITE, [255, 255, 0, 255], [102, 204, 255, 255], [71, 85, 105, 255]] as Rgba[]) {
      expect(pixelLuminance(colour[0], colour[1], colour[2])).toBeCloseTo(relativeLuminance(hex(colour)), 12);
    }
  });
});

describe("analyzeLogo", () => {
  it("finds no transparency in an opaque image", () => {
    const result = analyzeLogo(pixels(4, 3, () => INK));
    expect(result.transparent).toBe(false);
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 4, height: 3 });
  });

  it("treats alpha 250 and up as opaque, so encoder rounding doesn't count", () => {
    expect(analyzeLogo(pixels(2, 2, () => [17, 24, 39, 250])).transparent).toBe(false);
    expect(analyzeLogo(pixels(2, 2, (x) => (x ? INK : [17, 24, 39, 249]))).transparent).toBe(true);
  });

  it("finds the artwork's bounds inside a transparent canvas", () => {
    const result = analyzeLogo(artwork(INK));
    expect(result.transparent).toBe(true);
    expect(result.bounds).toEqual({ x: 2, y: 1, width: 6, height: 3 });
    expect(result.visibleShare).toBe(1);
  });

  it("leaves pixels under 3% opacity out of the bounds", () => {
    const result = analyzeLogo(
      pixels(10, 6, (x, y) => (x === 0 && y === 0 ? [17, 24, 39, 7] : x === 5 && y === 4 ? INK : CLEAR)),
    );
    expect(result.bounds).toEqual({ x: 5, y: 4, width: 1, height: 1 });
  });

  it("reports a blank image as having no artwork", () => {
    expect(analyzeLogo(pixels(3, 3, () => CLEAR))).toEqual({
      transparent: true,
      bounds: null,
      visibleShare: 0,
    });
  });

  it("measures white artwork as invisible on white", () => {
    expect(analyzeLogo(artwork(WHITE)).visibleShare).toBe(0);
    expect(analyzeLogo(artwork([255, 255, 0, 255])).visibleShare).toBe(0); // yellow, 1.07:1
  });

  it("counts ink as visible at 1.5:1 contrast with white or more", () => {
    for (let grey = 200; grey <= 220; grey++) {
      const colour: Rgba = [grey, grey, grey, 255];
      const visible = contrastRatio(hex(colour), "#ffffff") >= VISIBLE_ON_WHITE_CONTRAST;
      expect(analyzeLogo(pixels(1, 1, () => colour)).visibleShare).toBe(visible ? 1 : 0);
    }
  });

  it("weights each pixel by its opacity", () => {
    const result = analyzeLogo(pixels(2, 1, (x) => (x === 0 ? [17, 24, 39, 127] : WHITE)));
    expect(result.visibleShare).toBeCloseTo(127 / (127 + 255), 10);
  });
});

describe("planLogo", () => {
  const analysis = (overrides: Partial<LogoAnalysis>): LogoAnalysis => ({
    transparent: true,
    bounds: { x: 2, y: 1, width: 6, height: 3 },
    visibleShare: 1,
    ...overrides,
  });

  it("keeps an opaque raster as it is", () => {
    expect(planLogo(analysis({ transparent: false }), false)).toEqual({ action: "keep", veryLight: false });
  });

  it("rasterizes an opaque SVG without a tile", () => {
    expect(planLogo(analysis({ transparent: false }), true)).toEqual({ action: "rasterize" });
  });

  it("tiles transparent artwork that shows on white, raster or SVG", () => {
    const bounds = { x: 2, y: 1, width: 6, height: 3 };
    expect(planLogo(analysis({}), false)).toEqual({ action: "tile", bounds });
    expect(planLogo(analysis({}), true)).toEqual({ action: "tile", bounds });
  });

  it("keeps artwork that mostly doesn't show on white as it is, and flags it", () => {
    expect(planLogo(analysis({ visibleShare: 0 }), false)).toEqual({ action: "keep", veryLight: true });
    expect(planLogo(analysis({ visibleShare: 0.39 }), true)).toEqual({ action: "keep", veryLight: true });
    expect(planLogo(analysis({ visibleShare: 0.499 }), false)).toEqual({ action: "keep", veryLight: true });
    expect(planLogo(analysis({ visibleShare: 0.5 }), false).action).toBe("tile");
  });

  it("flags white lettering beside a coloured mark (a logo made for dark backgrounds)", () => {
    // Two thirds white, one third teal that shows on white, on a transparent canvas.
    const onDark = pixels(10, 3, (x) => (x === 9 ? CLEAR : x < 6 ? WHITE : [13, 110, 100, 255]));
    expect(planLogo(analyzeLogo(onDark), false)).toEqual({ action: "keep", veryLight: true });
  });

  it("flags a blank image", () => {
    expect(planLogo(analysis({ bounds: null, visibleShare: 0 }), false)).toEqual({
      action: "keep",
      veryLight: true,
    });
  });

  it("tiles the brief's example and keeps its white twin", () => {
    expect(planLogo(analyzeLogo(artwork(INK)), false).action).toBe("tile");
    expect(planLogo(analyzeLogo(artwork(WHITE)), false)).toEqual({ action: "keep", veryLight: true });
  });
});

describe("toSourceBox", () => {
  it("is the same box when measured at native size", () => {
    const box = { x: 2, y: 1, width: 6, height: 3 };
    expect(toSourceBox(box, { width: 10, height: 6 }, { width: 10, height: 6 }, true)).toEqual(box);
  });

  it("scales a box measured on a smaller copy out to whole pixels, within the image", () => {
    expect(
      toSourceBox({ x: 1, y: 0, width: 3, height: 2 }, { width: 4, height: 2 }, { width: 10, height: 5 }, true),
    ).toEqual({ x: 2, y: 0, width: 8, height: 5 });
  });

  it("keeps fractions for SVG", () => {
    expect(
      toSourceBox({ x: 6, y: 3, width: 1188, height: 290 }, { width: 1200, height: 300 }, { width: 300, height: 75 }, false),
    ).toEqual({ x: 1.5, y: 0.75, width: 297, height: 72.5 });
  });
});

describe("tileLayout", () => {
  it("keeps a 1000×250 logo at its own pixels with a 25 px margin", () => {
    expect(tileLayout({ x: 0, y: 0, width: 1000, height: 250 })).toEqual({
      scale: 1,
      width: 1050,
      height: 300,
      source: { x: 0, y: 0, width: 1000, height: 250 },
      dest: { x: 25, y: 25, width: 1000, height: 250 },
    });
  });

  it("measures the margin from the shorter side", () => {
    const tall = tileLayout({ x: 0, y: 0, width: 300, height: 900 });
    expect(tall.dest).toEqual({ x: 30, y: 30, width: 300, height: 900 });
    expect([tall.width, tall.height]).toEqual([360, 960]);
  });

  it("scales a wide logo down to fit TILE_MAX_SIDE", () => {
    const layout = tileLayout({ x: 0, y: 0, width: 2000, height: 500 });
    expect(layout.width).toBeLessThanOrEqual(TILE_MAX_SIDE);
    expect(layout.width).toBeGreaterThanOrEqual(TILE_MAX_SIDE - 2);
    expect(layout.dest.x).toBe(28); // 10% of 500, at 1200 / 2100 scale
    expect(layout.dest.width / layout.dest.height).toBeCloseTo(4, 1);
  });

  it("never scales a raster up", () => {
    const layout = tileLayout({ x: 3, y: 4, width: 100, height: 40 });
    expect(layout.scale).toBe(1);
    expect(layout.dest).toEqual({ x: 4, y: 4, width: 100, height: 40 });
  });

  it("scales an SVG up to TILE_MAX_SIDE", () => {
    const layout = tileLayout({ x: 0, y: 0, width: 300, height: 75 }, { upscale: true });
    expect(Math.max(layout.width, layout.height)).toBeLessThanOrEqual(TILE_MAX_SIDE);
    expect(layout.width).toBeGreaterThanOrEqual(TILE_MAX_SIDE - 2);
  });

  it("adds no margin when asked for none", () => {
    expect(tileLayout({ x: 0, y: 0, width: 300, height: 75 }, { marginRatio: 0, upscale: true })).toMatchObject({
      width: 1200,
      height: 300,
      dest: { x: 0, y: 0, width: 1200, height: 300 },
    });
  });

  it("keeps at least a 1 px margin around tiny artwork", () => {
    expect(tileLayout({ x: 0, y: 0, width: 5, height: 5 }).dest).toEqual({ x: 1, y: 1, width: 5, height: 5 });
  });

  it("stays inside maxSide with an even margin for any shape", () => {
    for (const [w, h] of [[1, 1], [37, 1301], [4999, 17], [1199, 1199], [640, 480], [12345, 6789]]) {
      for (const maxSide of [TILE_MAX_SIDE, 777, 64]) {
        const layout = tileLayout({ x: 0, y: 0, width: w, height: h }, { maxSide });
        expect(Math.max(layout.width, layout.height)).toBeLessThanOrEqual(maxSide);
        expect(layout.width).toBe(layout.dest.width + 2 * layout.dest.x);
        expect(layout.height).toBe(layout.dest.height + 2 * layout.dest.y);
        expect(layout.dest.x).toBeGreaterThanOrEqual(1);
        expect(layout.dest.x).toBeLessThanOrEqual(
          Math.ceil(TILE_MARGIN_RATIO * Math.min(layout.dest.width, layout.dest.height)) + 1,
        );
      }
    }
  });
});

describe("nextMaxSide", () => {
  it("keeps the size when the tile already fits", () => {
    expect(nextMaxSide(1200, LOGO_MAX_BYTES)).toBe(1200);
  });

  it("shrinks by the square root of the overshoot, with 10% to spare", () => {
    expect(nextMaxSide(1200, LOGO_MAX_BYTES * 4)).toBe(540);
    expect(nextMaxSide(1200, LOGO_MAX_BYTES + 1)).toBeLessThan(1200);
  });
});

describe("LOGO_MAX_BYTES", () => {
  it("is the 500 KB limit invoice creation and the PDF routes enforce", () => {
    expect(LOGO_MAX_BYTES).toBe(PDF_LOGO_MAX_BYTES);
    expect(LOGO_MAX_BYTES).toBe(500 * 1024);
  });
});
