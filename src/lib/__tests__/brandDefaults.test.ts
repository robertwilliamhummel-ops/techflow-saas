import { describe, expect, it } from "vitest";
import * as server from "../../../functions/src/shared/brandDefaults";
import * as pdf from "../../../pdf-service/src/brandDefaults";
import { contrastRatio, meetsWcagAA } from "../design/contrast";
import { DEFAULT_PRIMARY_COLOR, DEFAULT_SECONDARY_COLOR } from "../tenant/brandDefaults";

// D13: one neutral default brand for businesses that haven't chosen their own.
describe("default brand colours", () => {
  it("match the Cloud Functions and PDF service copies", () => {
    expect({ DEFAULT_PRIMARY_COLOR, DEFAULT_SECONDARY_COLOR }).toEqual({ ...server });
    expect({ DEFAULT_PRIMARY_COLOR, DEFAULT_SECONDARY_COLOR }).toEqual({ ...pdf });
  });

  it("pass the 4.5:1 contrast rule on white, so new businesses can save them", () => {
    expect(meetsWcagAA(DEFAULT_PRIMARY_COLOR)).toBe(true);
    expect(meetsWcagAA(DEFAULT_SECONDARY_COLOR)).toBe(true);
    expect(contrastRatio(DEFAULT_PRIMARY_COLOR, "#FFFFFF")).toBeGreaterThan(7);
  });

  it("are not the old app's purple pair", () => {
    expect([DEFAULT_PRIMARY_COLOR, DEFAULT_SECONDARY_COLOR]).not.toContain("#667eea");
    expect([DEFAULT_PRIMARY_COLOR, DEFAULT_SECONDARY_COLOR]).not.toContain("#764ba2");
  });
});
