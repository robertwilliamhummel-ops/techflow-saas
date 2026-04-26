// XSS-to-PDF fuzz tests — round-5 #6 / Phase 7 Bundle D.
//
// The PDF service runs Handlebars-rendered HTML through Puppeteer. Every
// user-controllable field flows through `{{ }}` (escaping) by template
// design; the only triple-stash is `{{{cssVars}}}`, which is server-built
// from the snapshot via `cssVarsFor` and sanitized via `sanitizeColor` /
// `sanitizeFont`. These tests pin that contract: hostile inputs MUST NOT
// produce executable HTML/CSS in the output.
//
// Failure modes we're guarding against:
//   1. A future template edit that switches a user field to `{{{ }}}`.
//   2. A future helper that returns a Handlebars.SafeString for user content.
//   3. A regression in `sanitizeColor`/`sanitizeFont` that lets quote/semicolon
//      payloads escape the cssVars expression.
//
// We test the HTML build step (`buildInvoiceHtml` / `buildQuoteHtml`) — the
// actual Puppeteer render is the same HTML in a browser, so escape-in-HTML
// is the whole battle. No browser launch needed.

import { describe, expect, it } from "vitest";
import { buildInvoiceHtml } from "../src/renderInvoice";
import { buildQuoteHtml } from "../src/renderQuote";
import {
  sanitizeColor,
  sanitizeFont,
  cssVarsFor,
} from "../src/renderInvoice";
import type {
  InvoiceData,
  RenderInvoiceRequest,
  RenderQuoteRequest,
  TenantSnapshot,
} from "../src/types";

// ---------------------------------------------------------------------------
// Hostile-input vocabulary. Each string is a real-world XSS / CSS-injection
// payload. We splat these across every user-controllable string field to
// confirm Handlebars escapes them.
// ---------------------------------------------------------------------------

const XSS_VECTORS = [
  `<script>alert('xss')</script>`,
  `<img src=x onerror="alert(1)">`,
  `</title><script>alert(1)</script>`,
  `</style><script>alert(1)</script>`,
  `"><svg onload=alert(1)>`,
  `' onmouseover='alert(1)`,
  `javascript:alert(1)`,
  `<iframe src="javascript:alert(1)"></iframe>`,
  `<a href="javascript:alert(1)">click</a>`,
  `<body onload=alert(1)>`,
  `&lt;script&gt;alert(1)&lt;/script&gt;`, // already-escaped should stay escaped, not double-escaped
];

const baseSnapshot: TenantSnapshot = {
  version: 1,
  name: "Acme Co",
  logo: null,
  address: "123 Main St",
  primaryColor: "#667eea",
  secondaryColor: "#764ba2",
  fontFamily: "Inter",
  faviconUrl: null,
  taxRate: 0.13,
  taxName: "HST",
  businessNumber: null,
  emailFooter: null,
  currency: "CAD",
  chargeCustomerCardFees: false,
  cardFeePercent: 2.4,
  etransferEmail: null,
};

const baseInvoice: InvoiceData = {
  invoiceId: "INV-0001",
  issueDate: "2026-04-26",
  dueDate: "2026-05-26",
  status: "sent",
  customer: { name: "Jane", email: "jane@example.com", phone: null },
  lineItems: [{ description: "Work", quantity: 1, rate: 100, amount: 100 }],
  totals: { subtotal: 100, taxRate: 0.13, taxAmount: 13, total: 113 },
  notes: null,
};

function invoiceReq(
  snapshotPatch: Partial<TenantSnapshot> = {},
  dataPatch: Partial<InvoiceData> = {},
): RenderInvoiceRequest {
  return {
    snapshot: { ...baseSnapshot, ...snapshotPatch },
    data: { ...baseInvoice, ...dataPatch },
  };
}

function quoteReq(
  snapshotPatch: Partial<TenantSnapshot> = {},
  dataPatch: Partial<RenderQuoteRequest["data"]> = {},
): RenderQuoteRequest {
  return {
    snapshot: { ...baseSnapshot, ...snapshotPatch },
    data: {
      quoteId: "QT-0001",
      issueDate: "2026-04-26",
      validUntil: "2026-05-26",
      status: "sent",
      customer: baseInvoice.customer,
      lineItems: baseInvoice.lineItems,
      totals: baseInvoice.totals,
      notes: null,
      ...dataPatch,
    },
  };
}

// The danger is unescaped HTML tag-openers from user input. These tag names
// never appear in the template chrome, so any occurrence is a literal `<`
// that escaped entity encoding. (Plain-text substrings like `javascript:`
// or `onerror=` are NOT a leak — they only become dangerous inside an
// actual tag, which requires the unescaped `<` we already check for.)
function expectNoExecutableHtml(html: string, vector: string): void {
  const lower = html.toLowerCase();
  const forbidden = ["<script", "<iframe", "<svg", "<a ", "<a\t", "<a>"];
  for (const tag of forbidden) {
    expect(
      lower,
      `vector ${JSON.stringify(vector)} produced unescaped ${tag}`,
    ).not.toContain(tag);
  }
  // `<img` and `<body` ARE in the template chrome. Allow exactly one `<body`
  // and only `<img` whose `src` starts with `data:` (logo + QR).
  const bodyOpens = (lower.match(/<body\b/g) ?? []).length;
  expect(
    bodyOpens,
    `vector ${JSON.stringify(vector)} produced ${bodyOpens} <body> openers (expected 1)`,
  ).toBe(1);
  const imgMatches = lower.match(/<img\s+[^>]*>/g) ?? [];
  for (const img of imgMatches) {
    expect(
      img,
      `vector ${JSON.stringify(vector)} produced suspicious <img>: ${img}`,
    ).toMatch(/<img\s+src="data:/);
  }
}

// ---------------------------------------------------------------------------
// Invoice — every user string field, against every vector.
// ---------------------------------------------------------------------------

describe("invoice HTML escapes hostile inputs", () => {
  for (const vector of XSS_VECTORS) {
    it(`escapes vector in customer.name: ${vector.slice(0, 40)}`, async () => {
      const html = await buildInvoiceHtml(
        invoiceReq({}, { customer: { ...baseInvoice.customer, name: vector } }),
      );
      expectNoExecutableHtml(html, vector);
    });

    it(`escapes vector in customer.email: ${vector.slice(0, 40)}`, async () => {
      const html = await buildInvoiceHtml(
        invoiceReq({}, { customer: { ...baseInvoice.customer, email: vector } }),
      );
      expectNoExecutableHtml(html, vector);
    });

    it(`escapes vector in customer.phone: ${vector.slice(0, 40)}`, async () => {
      const html = await buildInvoiceHtml(
        invoiceReq(
          {},
          { customer: { ...baseInvoice.customer, phone: vector } },
        ),
      );
      expectNoExecutableHtml(html, vector);
    });

    it(`escapes vector in lineItems[].description: ${vector.slice(0, 40)}`, async () => {
      const html = await buildInvoiceHtml(
        invoiceReq(
          {},
          {
            lineItems: [
              { description: vector, quantity: 1, rate: 100, amount: 100 },
            ],
          },
        ),
      );
      expectNoExecutableHtml(html, vector);
    });

    it(`escapes vector in notes: ${vector.slice(0, 40)}`, async () => {
      const html = await buildInvoiceHtml(invoiceReq({}, { notes: vector }));
      expectNoExecutableHtml(html, vector);
    });

    it(`escapes vector in snapshot.name: ${vector.slice(0, 40)}`, async () => {
      const html = await buildInvoiceHtml(invoiceReq({ name: vector }));
      expectNoExecutableHtml(html, vector);
    });

    it(`escapes vector in snapshot.address: ${vector.slice(0, 40)}`, async () => {
      const html = await buildInvoiceHtml(invoiceReq({ address: vector }));
      expectNoExecutableHtml(html, vector);
    });

    it(`escapes vector in snapshot.businessNumber: ${vector.slice(0, 40)}`, async () => {
      const html = await buildInvoiceHtml(
        invoiceReq({ businessNumber: vector }),
      );
      expectNoExecutableHtml(html, vector);
    });

    it(`escapes vector in snapshot.emailFooter: ${vector.slice(0, 40)}`, async () => {
      const html = await buildInvoiceHtml(invoiceReq({ emailFooter: vector }));
      expectNoExecutableHtml(html, vector);
    });

    it(`escapes vector in snapshot.taxName: ${vector.slice(0, 40)}`, async () => {
      // taxName only renders when there's a non-zero taxAmount.
      const html = await buildInvoiceHtml(
        invoiceReq(
          { taxName: vector },
          {
            totals: {
              subtotal: 100,
              taxRate: 0.13,
              taxAmount: 13,
              total: 113,
            },
          },
        ),
      );
      expectNoExecutableHtml(html, vector);
    });

    it(`escapes vector in snapshot.etransferEmail: ${vector.slice(0, 40)}`, async () => {
      const html = await buildInvoiceHtml(
        invoiceReq({ etransferEmail: vector }),
      );
      expectNoExecutableHtml(html, vector);
    });
  }

  it("escapes < > & in customer.name to entities", async () => {
    const html = await buildInvoiceHtml(
      invoiceReq(
        {},
        { customer: { name: "<b>Jane & Co</b>", email: "j@x.com", phone: null } },
      ),
    );
    expect(html).toContain("&lt;b&gt;Jane &amp; Co&lt;/b&gt;");
    expect(html).not.toContain("<b>Jane");
  });

  it("escapes quote/double-quote in line item description", async () => {
    const html = await buildInvoiceHtml(
      invoiceReq(
        {},
        {
          lineItems: [
            {
              description: `"><img src=x onerror=alert(1)>`,
              quantity: 1,
              rate: 1,
              amount: 1,
            },
          ],
        },
      ),
    );
    expect(html).toContain("&quot;");
    expect(html).not.toMatch(/<img\s+src=x\s+onerror/i);
  });
});

// ---------------------------------------------------------------------------
// Quote — same vectors against quote-specific fields.
// ---------------------------------------------------------------------------

describe("quote HTML escapes hostile inputs", () => {
  for (const vector of XSS_VECTORS) {
    it(`escapes vector in quote customer.name: ${vector.slice(0, 40)}`, async () => {
      const html = await buildQuoteHtml(
        quoteReq(
          {},
          { customer: { ...baseInvoice.customer, name: vector } },
        ),
      );
      expectNoExecutableHtml(html, vector);
    });

    it(`escapes vector in quote lineItems[].description: ${vector.slice(0, 40)}`, async () => {
      const html = await buildQuoteHtml(
        quoteReq(
          {},
          {
            lineItems: [
              { description: vector, quantity: 1, rate: 1, amount: 1 },
            ],
          },
        ),
      );
      expectNoExecutableHtml(html, vector);
    });

    it(`escapes vector in quote notes: ${vector.slice(0, 40)}`, async () => {
      const html = await buildQuoteHtml(quoteReq({}, { notes: vector }));
      expectNoExecutableHtml(html, vector);
    });

    it(`escapes vector in quote snapshot.name: ${vector.slice(0, 40)}`, async () => {
      const html = await buildQuoteHtml(quoteReq({ name: vector }));
      expectNoExecutableHtml(html, vector);
    });
  }
});

// ---------------------------------------------------------------------------
// CSS injection through the only triple-stash sink.
// ---------------------------------------------------------------------------

describe("cssVars sanitization", () => {
  // sanitizeColor accepts only `#RGB`/`#RRGGBB`/`#RRGGBBAA` — anything else
  // returns null and the renderer falls back to the default color.
  const HOSTILE_COLORS = [
    `red;}body{background:url('javascript:alert(1)')}`,
    `#fff;background:url(//evil.example.com)`,
    `expression(alert(1))`,
    `<script>alert(1)</script>`,
    `#zzz`, // wrong charset
    `red`, // not a hex color
    `#12345`, // wrong length
    `#1234567`, // wrong length
  ];

  for (const c of HOSTILE_COLORS) {
    it(`sanitizeColor rejects: ${c.slice(0, 40)}`, () => {
      expect(sanitizeColor(c)).toBeNull();
    });
  }

  // sanitizeFont allows alphanumerics + space + hyphen only.
  const HOSTILE_FONTS = [
    `Inter';color:red;font-family:'Arial`,
    `Inter</style><script>alert(1)</script>`,
    `Inter;}body{display:none}`,
    `Inter,'Helvetica`,
    `Inter"`,
    `Inter\\`,
    `Inter;`,
  ];

  for (const f of HOSTILE_FONTS) {
    it(`sanitizeFont rejects: ${f.slice(0, 40)}`, () => {
      expect(sanitizeFont(f)).toBeNull();
    });
  }

  it("cssVarsFor falls back to defaults when colors and font are hostile", () => {
    const out = cssVarsFor({
      ...baseSnapshot,
      primaryColor: `red;}body{display:none`,
      secondaryColor: `expression(alert(1))`,
      fontFamily: `Inter';color:red;font-family:'Arial`,
    });
    // Sanitized to defaults — nothing dangerous leaks.
    expect(out).toBe(
      `--accent:#667eea;--accent-2:#764ba2;--font-body:'Inter', system-ui, sans-serif;`,
    );
    expect(out).not.toContain(";}");
    expect(out).not.toContain("expression");
    expect(out).not.toContain("</style>");
    expect(out).not.toContain("alert(");
  });

  it("cssVarsFor inlines a sanitized color as-is", () => {
    const out = cssVarsFor({
      ...baseSnapshot,
      primaryColor: "#abcdef",
      secondaryColor: "#123456",
      fontFamily: "Roboto Mono",
    });
    expect(out).toContain("--accent:#abcdef");
    expect(out).toContain("--accent-2:#123456");
    expect(out).toContain("--font-body:'Roboto Mono'");
  });

  it("hostile cssVars never produce a closing </style> tag in the rendered HTML", async () => {
    const html = await buildInvoiceHtml(
      invoiceReq({
        primaryColor: `red;}</style><script>alert(1)</script><style>`,
        secondaryColor: `red`,
        fontFamily: `Inter</style>`,
      }),
    );
    // The template's own </style> is the ONLY one allowed. Count must be 1.
    const styleClose = html.match(/<\/style>/gi) ?? [];
    expect(styleClose.length).toBe(1);
    expect(html.toLowerCase()).not.toContain("<script");
  });
});

// ---------------------------------------------------------------------------
// payUrl is server-validated to https:// — but the template re-renders the
// raw string as visible text. Confirm escaping for a hostile-typed payUrl.
// ---------------------------------------------------------------------------

describe("payUrl render", () => {
  it("escapes a payUrl with HTML metacharacters when displayed", async () => {
    // We bypass validate.ts here because validate would have rejected this —
    // the test asserts defense-in-depth in the renderer itself, not duplicate
    // validation. (If validate is ever bypassed, the renderer must still be
    // safe.)
    const html = await buildInvoiceHtml({
      snapshot: baseSnapshot,
      data: {
        ...baseInvoice,
        payUrl: `https://pay.example.com/"><script>alert(1)</script>`,
      },
    });
    expectNoExecutableHtml(html, "payUrl with script");
    expect(html).toContain("&quot;");
  });
});
