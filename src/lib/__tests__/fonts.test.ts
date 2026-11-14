import { describe, expect, it, vi } from "vitest";
import * as server from "../../../functions/src/shared/fonts";
import { toCustomerBusinessView } from "../../../functions/src/portal/customerDocView";
import * as pdf from "../../../pdf-service/src/fonts";
import { DEFAULT_TENANT_FONT, TENANT_FONTS, resolveTenantFont } from "../design/fonts";

// next/font/google only works inside the Next compiler; record what each
// loader is asked for instead.
const loaderOptions = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("next/font/google", () => {
  const loader = (family: string) => (options: Record<string, unknown>) => {
    loaderOptions.set(family, options);
    return { className: `class-${family}`, variable: `variable-${family}`, style: {} };
  };
  return {
    Roboto: loader("Roboto"),
    Open_Sans: loader("Open Sans"),
    Lato: loader("Lato"),
    Montserrat: loader("Montserrat"),
    Poppins: loader("Poppins"),
    Source_Sans_3: loader("Source Sans 3"),
    Merriweather: loader("Merriweather"),
  };
});

const { tenantFontClass } = await import("../design/tenantFontClass");

const OFF_LIST = ["Comic Sans MS", "inter", " Inter", "", null, undefined, 3, "toString", "__proto__"];

// G-04: the business's font on its pages and PDFs.
describe("tenant fonts", () => {
  it("match the Cloud Functions and PDF service lists", () => {
    expect(server.TENANT_FONTS).toEqual(TENANT_FONTS);
    expect(pdf.TENANT_FONTS).toEqual(TENANT_FONTS);
    expect(server.DEFAULT_TENANT_FONT).toBe(DEFAULT_TENANT_FONT);
    expect(pdf.DEFAULT_TENANT_FONT).toBe(DEFAULT_TENANT_FONT);
  });

  it("resolve every value the same way in all three copies", () => {
    for (const value of [...TENANT_FONTS, ...OFF_LIST]) {
      expect(server.resolveTenantFont(value)).toBe(resolveTenantFont(value));
      expect(pdf.resolveFont(value)).toBe(resolveTenantFont(value));
    }
    // The old `in` check accepted Object.prototype keys as fonts.
    expect(resolveTenantFont("toString")).toBe("Inter");
  });

  it("reach the pay page and portal through the customer views", () => {
    expect(toCustomerBusinessView({ fontFamily: "Merriweather" }).fontFamily).toBe("Merriweather");
    expect(toCustomerBusinessView({ fontFamily: "Comic Sans MS" }).fontFamily).toBe("Inter");
    expect(toCustomerBusinessView({}).fontFamily).toBe("Inter");
  });
});

describe("tenantFontClass", () => {
  it("gives every family but Inter its own loader, applied through font-sans", () => {
    for (const font of TENANT_FONTS.filter((f) => f !== DEFAULT_TENANT_FONT)) {
      expect(tenantFontClass(font)).toBe(`variable-${font} font-sans`);
    }
  });

  it("leaves Inter and names off the list in the platform font", () => {
    for (const value of [DEFAULT_TENANT_FONT, ...OFF_LIST]) {
      expect(tenantFontClass(value)).toBe("");
    }
  });

  it("self-hosts the families without preloading them", () => {
    // preload would fetch all seven on every customer page; the browser fetches
    // an @font-face file only for text that uses it.
    expect([...loaderOptions.keys()].sort()).toEqual(
      TENANT_FONTS.filter((f) => f !== DEFAULT_TENANT_FONT).sort(),
    );
    for (const options of loaderOptions.values()) {
      expect(options).toMatchObject({ preload: false, variable: "--font-sans", display: "swap" });
    }
  });
});
