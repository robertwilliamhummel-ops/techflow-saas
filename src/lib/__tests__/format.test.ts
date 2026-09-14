import { describe, expect, it } from "vitest";
import { dollarsToCents, formatIsoDate, formatMoneyCents } from "@/lib/format";

describe("dollarsToCents", () => {
  it("rounds away float error", () => {
    expect(dollarsToCents(435.05)).toBe(43505);
    expect(dollarsToCents(0.1 + 0.2)).toBe(30);
  });
});

describe("formatMoneyCents", () => {
  it("formats Canadian dollars", () => {
    expect(formatMoneyCents(123456, "CAD")).toBe("$1,234.56");
  });

  it("marks US dollars so they can't be mistaken for CAD", () => {
    const text = formatMoneyCents(123456, "USD");
    expect(text).toContain("US$");
    expect(text).toContain("1,234.56");
  });
});

describe("formatIsoDate", () => {
  it("formats a calendar date", () => {
    expect(formatIsoDate("2026-09-14")).toMatch(/Sep.*14.*2026/);
  });

  it("never shifts the day or year with the time zone", () => {
    const text = formatIsoDate("2026-01-01");
    expect(text).toMatch(/Jan/);
    expect(text).toMatch(/\b1\b/);
    expect(text).toContain("2026");
  });

  it("returns anything else unchanged", () => {
    expect(formatIsoDate("not a date")).toBe("not a date");
  });
});
