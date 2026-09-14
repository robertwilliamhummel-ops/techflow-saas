import { describe, expect, it } from "vitest";
import { isIsoCalendarDate } from "../../src/shared/dates";

describe("isIsoCalendarDate", () => {
  it.each(["2026-09-14", "2026-12-31", "2028-02-29", "2026-01-01"])(
    "accepts the real date %s",
    (value) => {
      expect(isIsoCalendarDate(value)).toBe(true);
    },
  );

  it.each(["2026-02-29", "2026-02-30", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00"])(
    "rejects the impossible date %s",
    (value) => {
      expect(isIsoCalendarDate(value)).toBe(false);
    },
  );

  it.each(["2026-9-14", "14/09/2026", "2026-09-14T00:00:00Z", "", " 2026-09-14", "0099-01-01"])(
    "rejects %j, which isn't a YYYY-MM-DD calendar date",
    (value) => {
      expect(isIsoCalendarDate(value)).toBe(false);
    },
  );
});
