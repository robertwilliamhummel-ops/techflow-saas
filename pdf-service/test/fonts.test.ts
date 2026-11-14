// G-04 — PDFs render in the business's chosen font. Chrome in the image has
// none of the curated fonts and a render loads nothing over the network
// (U-02), so the chosen family's vendored WOFF2 files are embedded in the page
// as data: URLs (src/fonts.ts).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_TENANT_FONT,
  FONT_DIR,
  FONT_WEIGHTS,
  TENANT_FONTS,
  fontFaceCss,
  fontFilePath,
  fontLicensePath,
  resolveFont,
} from "../src/fonts";
import { buildInvoiceHtml } from "../src/renderInvoice";
import { buildQuoteHtml } from "../src/renderQuote";
import type { RenderInvoiceRequest, TenantSnapshot } from "../src/types";

const ROOT = path.resolve(__dirname, "..");

const snapshot: TenantSnapshot = {
  version: 1,
  name: "Côté Plumbing",
  logo: null,
  address: "12 King St W, Toronto",
  primaryColor: "#1d4ed8",
  secondaryColor: "#334155",
  fontFamily: "Inter",
  faviconUrl: null,
  taxRate: 0.13,
  taxName: "HST",
  businessNumber: null,
  emailFooter: "Thanks for your business",
  currency: "CAD",
  chargeCustomerCardFees: false,
  cardFeePercent: 2.4,
  etransferEmail: "pay@cote.test",
};

function invoice(fontFamily: string): RenderInvoiceRequest {
  return {
    snapshot: { ...snapshot, fontFamily },
    data: {
      invoiceId: "INV-0042",
      issueDate: "2026-11-13",
      dueDate: "2026-12-13",
      status: "sent",
      customer: { name: "Renée Lefèbvre", email: "renee@example.com", phone: null },
      lineItems: [{ description: "Service call — after hours", quantity: 1, rate: 95, amount: 95 }],
      totals: { subtotal: 95, taxRate: 0.13, taxAmount: 12.35, total: 107.35 },
      notes: null,
      payUrl: "https://portal.example.com/p/abc123",
    },
  };
}

/** The family names that have @font-face rules in a page. */
function embeddedFamilies(html: string): string[] {
  return [...html.matchAll(/@font-face\{font-family:'([^']+)'/g)].map((m) => m[1]);
}

// Table tags in a WOFF2 file's directory (W3C WOFF 2.0, section 5.2), enough to
// tell a variable font (fvar) from a static one.
const WOFF2_KNOWN_TAGS = "cmap head hhea hmtx maxp name OS/2 post cvt fpgm glyf loca prep CFF VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill".split(" ");

function woff2Tables(bytes: Buffer): string[] {
  let at = 48; // the table directory follows the 48-byte header
  const base128 = (): number => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = bytes[at++];
      value = (value << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw new Error("bad UIntBase128");
  };
  const tags: string[] = [];
  for (let n = bytes.readUInt16BE(12); n > 0; n--) {
    const flags = bytes[at++];
    let tag = WOFF2_KNOWN_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) {
      tag = bytes.toString("latin1", at, at + 4).trim();
      at += 4;
    }
    const version = flags >> 6;
    base128(); // origLength
    const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
    if (transformed) base128(); // transformLength
    tags.push(tag);
  }
  return tags;
}

describe("vendored font files (G-04)", () => {
  it("holds exactly one directory per listed family", () => {
    const dirs = TENANT_FONTS.map((font) => path.basename(path.dirname(fontFilePath(font, 400))));
    expect(readdirSync(FONT_DIR).sort()).toEqual([...dirs].sort());
  });

  for (const font of TENANT_FONTS) {
    it(`has ${font} as static Latin WOFF2, regular and bold, with its OFL`, () => {
      for (const weight of FONT_WEIGHTS) {
        const bytes = readFileSync(fontFilePath(font, weight));
        expect(bytes.toString("latin1", 0, 4)).toBe("wOF2");
        expect(bytes.readUInt32BE(4)).toBe(0x00010000); // TrueType outlines
        const tables = woff2Tables(bytes);
        expect(tables).toContain("glyf");
        // Chrome's PDF backend writes a variable font as Type 3 glyphs.
        expect(tables).not.toContain("fvar");
        expect(bytes.length).toBeLessThan(64 * 1024);
      }
      expect(readFileSync(fontLicensePath(font), "utf8")).toContain(
        "This Font Software is licensed under the SIL Open Font License, Version 1.1.",
      );
    });
  }
});

describe("@font-face rules (G-04)", () => {
  for (const font of TENANT_FONTS) {
    it(`embeds ${font}'s files byte for byte as data: URLs`, () => {
      const rules = fontFaceCss(font).split("\n");
      expect(rules).toHaveLength(FONT_WEIGHTS.length);
      FONT_WEIGHTS.forEach((weight, i) => {
        expect(rules[i]).toContain(`font-family:'${font}';font-style:normal;font-weight:${weight};`);
        const data = /url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/.exec(rules[i])?.[1];
        expect(Buffer.from(data ?? "", "base64").equals(readFileSync(fontFilePath(font, weight)))).toBe(true);
      });
    });
  }

  it("resolves names off the list to the platform font", () => {
    expect(DEFAULT_TENANT_FONT).toBe("Inter");
    expect(resolveFont("Merriweather")).toBe("Merriweather");
    for (const value of ["Comic Sans MS", "merriweather", " Inter", "", null, undefined, 42, "toString"]) {
      expect(resolveFont(value)).toBe("Inter");
    }
  });
});

describe("documents carry the snapshot's font (G-04)", () => {
  it("an invoice embeds only the chosen family and uses it for the body", async () => {
    const html = await buildInvoiceHtml(invoice("Merriweather"));
    expect(embeddedFamilies(html)).toEqual(["Merriweather", "Merriweather"]);
    expect(html).toContain("--font-body:'Merriweather', Georgia, serif;");
    expect(html).toContain("font-family: var(--font-body);");
  });

  it("a quote does too", async () => {
    const html = await buildQuoteHtml({
      snapshot: { ...snapshot, fontFamily: "Poppins" },
      data: {
        quoteId: "QT-0007",
        issueDate: "2026-11-13",
        validUntil: "2026-12-13",
        status: "sent",
        customer: { name: "Renée", email: "renee@example.com", phone: null },
        lineItems: [{ description: "Estimate", quantity: 1, rate: 200, amount: 200 }],
        totals: { subtotal: 200, taxRate: 0.13, taxAmount: 26, total: 226 },
        notes: null,
      },
    });
    expect(embeddedFamilies(html)).toEqual(["Poppins", "Poppins"]);
    expect(html).toContain("--font-body:'Poppins', system-ui, sans-serif;");
  });

  it("a font from outside the list renders in Inter, and its name goes nowhere", async () => {
    const html = await buildInvoiceHtml(invoice("Comic Sans MS"));
    expect(embeddedFamilies(html)).toEqual(["Inter", "Inter"]);
    expect(html).toContain("--font-body:'Inter', system-ui, sans-serif;");
    expect(html).not.toContain("Comic Sans");
  });

  for (const font of TENANT_FONTS) {
    it(`U-02: with ${font}, every CSS url() is a data: URL`, async () => {
      const html = await buildInvoiceHtml(invoice(font));
      const urls = [...html.matchAll(/url\(\s*["']?([^"')\s]*)/gi)].map((m) => m[1]);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url).toMatch(/^data:font\/woff2;base64,/);
      expect(html).not.toMatch(/@import/i);
    });
  }
});

describe("Dockerfile ships the fonts (G-04)", () => {
  it("copies src/fonts next to the compiled code, where fonts.ts reads them", () => {
    const instructions = readFileSync(path.join(ROOT, "Dockerfile"), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(instructions).toMatch(/^COPY src\/fonts \.\/dist\/fonts$/m);
    expect(instructions).toMatch(/^COPY src\/templates \.\/dist\/templates$/m);
    // Under the tests __dirname is src/; in the image it is dist/.
    expect(FONT_DIR).toBe(path.join(ROOT, "src", "fonts"));
  });
});

// Set PDF_TEST_CHROME to a Chrome for Testing executable to render in a real
// Chrome (see puppeteerRuntime.test.ts). Skipped otherwise.
describe.skipIf(!process.env.PDF_TEST_CHROME)("in a real Chrome (G-04)", () => {
  const previousPath = process.env.PUPPETEER_EXECUTABLE_PATH;

  afterAll(async () => {
    const { closeBrowser } = await import("../src/browser");
    await closeBrowser();
    if (previousPath === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previousPath;
  });

  it("loads the chosen family from the page itself, with no network request", async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    const { CHROME_ARGS } = await import("../src/browser");
    const browser = await puppeteer.launch({
      executablePath: process.env.PDF_TEST_CHROME,
      headless: true,
      args: CHROME_ARGS,
    });
    try {
      const page = await browser.newPage();
      const requested: string[] = [];
      page.on("request", (request) => requested.push(request.url()));
      await page.setContent(await buildInvoiceHtml(invoice("Merriweather")), { waitUntil: "load" });
      const faces = await page.evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts].map((face) => `${face.family} ${face.weight} ${face.status}`);
      });
      expect(faces).toEqual(["Merriweather 400 loaded", "Merriweather 700 loaded"]);
      for (const url of requested) expect(url).toMatch(/^data:/);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("embeds the family in the PDF as TrueType, not Type 3 glyphs", async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = process.env.PDF_TEST_CHROME;
    const { renderInvoicePDF } = await import("../src/renderInvoice");
    const pdf = (await renderInvoicePDF(invoice("Poppins"))).toString("latin1");
    const fonts = [...pdf.matchAll(/\/BaseFont\s*\/[A-Z]{6}\+([^\s/<>[\]]+)/g)].map((m) => m[1]);
    expect(fonts).toEqual(expect.arrayContaining(["Poppins-Regular", "Poppins-Bold"]));
    expect(pdf).not.toMatch(/\/Subtype\s*\/Type3/);
  }, 30_000);
});
