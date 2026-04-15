import { describe, it, expect } from "vitest";
import {
  contrastRatio,
  meetsWcagAA,
  computeForeground,
  relativeLuminance,
} from "./contrast";

describe("contrastRatio", () => {
  it("black vs white is 21:1", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
  });

  it("same color is 1:1", () => {
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#123456", "#FFFFFF")).toBeCloseTo(
      contrastRatio("#FFFFFF", "#123456"),
      5,
    );
  });

  it("supports 3-digit hex", () => {
    expect(contrastRatio("#000", "#FFF")).toBeCloseTo(21, 1);
  });
});

describe("meetsWcagAA", () => {
  it("rejects pure red on white (fails AA)", () => {
    expect(meetsWcagAA("#FF0000", "#FFFFFF")).toBe(false);
  });

  it("accepts dark blue on white", () => {
    expect(meetsWcagAA("#0066CC", "#FFFFFF")).toBe(true);
  });

  it("accepts black on white", () => {
    expect(meetsWcagAA("#000000")).toBe(true);
  });

  it("rejects light yellow on white", () => {
    expect(meetsWcagAA("#FFFF00", "#FFFFFF")).toBe(false);
  });
});

describe("computeForeground", () => {
  it("returns white on dark backgrounds", () => {
    expect(computeForeground("#000000")).toBe("#FFFFFF");
    expect(computeForeground("#222222")).toBe("#FFFFFF");
    expect(computeForeground("#0066CC")).toBe("#FFFFFF");
  });

  it("returns black on light backgrounds", () => {
    expect(computeForeground("#FFFFFF")).toBe("#000000");
    expect(computeForeground("#FFFF00")).toBe("#000000");
    expect(computeForeground("#EEEEEE")).toBe("#000000");
  });
});

describe("relativeLuminance", () => {
  it("throws on invalid hex", () => {
    expect(() => relativeLuminance("not-a-color")).toThrow();
  });

  it("accepts hex without leading #", () => {
    expect(relativeLuminance("FFFFFF")).toBeCloseTo(1, 5);
  });
});
