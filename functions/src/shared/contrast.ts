// Mirror of src/lib/design/contrast.ts — functions package compiles separately
// with rootDir: src so it can't import from the Next.js app. Keep in sync.

const HEX_RE = /^#?([a-f\d]{3}|[a-f\d]{6})$/i;

function hexToRgb(hex: string): [number, number, number] {
  const match = HEX_RE.exec(hex.trim());
  if (!match) throw new Error(`Invalid hex color: ${hex}`);
  let h = match[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const int = parseInt(h, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function meetsWcagAA(hex: string, against: string = "#FFFFFF"): boolean {
  return contrastRatio(hex, against) >= 4.5;
}

export function isValidHexColor(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(v.trim());
}
