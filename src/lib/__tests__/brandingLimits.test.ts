import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOGO_MAX_BYTES as SERVER_LOGO_MAX_BYTES } from "../../../functions/src/shared/logo";
import { MAX_LOGO_DATA_URL } from "../../../pdf-service/src/validate";
import { PDF_LOGO_MAX_BYTES } from "../pdf/logo";
import { FAVICON_MAX_BYTES, LOGO_MAX_BYTES } from "../tenant/brandingLimits";

const rules = readFileSync(path.resolve(process.cwd(), "storage.rules"), "utf8");

// The size check storage.rules applies to logo.* or favicon.* uploads.
function ruleLimit(file: "logo" | "favicon"): { op: string; bytes: number } {
  const check = new RegExp(
    `matches\\('\\^${file}\\[\\.\\]\\.\\*'\\) && request\\.resource\\.size (<=|<) ([\\d *]+)\\)`,
  ).exec(rules);
  if (!check) throw new Error(`storage.rules has no size limit for ${file}`);
  const bytes = check[2].split("*").reduce((n, factor) => n * Number(factor.trim()), 1);
  return { op: check[1], bytes };
}

// F-01: a logo the Branding page accepts must never fail an invoice or quote.
describe("logo and favicon upload limits", () => {
  it("allow exactly the logo size invoices, quotes and the PDF routes accept", () => {
    expect(LOGO_MAX_BYTES).toBe(SERVER_LOGO_MAX_BYTES);
    expect(PDF_LOGO_MAX_BYTES).toBe(LOGO_MAX_BYTES);
    expect(ruleLimit("logo")).toEqual({ op: "<=", bytes: LOGO_MAX_BYTES });
  });

  it("fit a logo at the limit into the pdf-service's data URL cap", () => {
    const longest = "data:image/svg+xml;base64,".length + 4 * Math.ceil(LOGO_MAX_BYTES / 3);
    expect(longest).toBeLessThanOrEqual(MAX_LOGO_DATA_URL);
  });

  it("keep the favicon's own 2 MB limit", () => {
    expect(ruleLimit("favicon")).toEqual({ op: "<", bytes: FAVICON_MAX_BYTES });
    expect(FAVICON_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});
