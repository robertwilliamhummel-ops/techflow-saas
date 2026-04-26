import { describe, expect, it } from "vitest";
import { buildInvoiceHtml } from "../src/renderInvoice";
import { buildQuoteHtml } from "../src/renderQuote";
import type {
  RenderInvoiceRequest,
  RenderQuoteRequest,
  TenantSnapshot,
} from "../src/types";

const baseSnapshot: TenantSnapshot = {
  version: 1,
  name: "Acme Plumbing",
  logo: null,
  address: "123 Main St, Toronto",
  primaryColor: "#667eea",
  secondaryColor: "#764ba2",
  fontFamily: "Inter",
  faviconUrl: null,
  taxRate: 0.13,
  taxName: "HST",
  businessNumber: "BN-12345",
  emailFooter: "Thanks for your business!",
  currency: "CAD",
  chargeCustomerCardFees: false,
  cardFeePercent: 2.4,
  etransferEmail: "pay@acme.test",
};

const baseInvoice: RenderInvoiceRequest = {
  snapshot: baseSnapshot,
  data: {
    invoiceId: "INV-0042",
    issueDate: "2026-04-26",
    dueDate: "2026-05-26",
    status: "sent",
    customer: {
      name: "Jane Doe",
      email: "jane@example.com",
      phone: "555-1234",
    },
    lineItems: [
      { description: "Faucet install", quantity: 2, rate: 150, amount: 300 },
      { description: "Service call", quantity: 1, rate: 85, amount: 85 },
    ],
    totals: { subtotal: 385, taxRate: 0.13, taxAmount: 50.05, total: 435.05 },
    notes: "Net 30",
    payUrl: "https://pay.example.com/i/abc",
  },
};

describe("invoice template", () => {
  it("escapes <script> in tenant name (XSS-to-PDF guard)", async () => {
    const html = await buildInvoiceHtml({
      ...baseInvoice,
      snapshot: {
        ...baseSnapshot,
        name: "<script>fetch('//evil')</script>",
      },
    });
    expect(html).not.toContain("<script>fetch");
    expect(html).toContain("&lt;script&gt;fetch");
  });

  it("escapes hostile line item description", async () => {
    const html = await buildInvoiceHtml({
      ...baseInvoice,
      data: {
        ...baseInvoice.data,
        lineItems: [
          {
            description: '"><img src=x onerror=alert(1)>',
            quantity: 1,
            rate: 1,
            amount: 1,
          },
        ],
      },
    });
    expect(html).not.toContain("<img src=x onerror");
    expect(html).toContain("&quot;&gt;&lt;img");
  });

  it("escapes hostile customer name", async () => {
    const html = await buildInvoiceHtml({
      ...baseInvoice,
      data: {
        ...baseInvoice.data,
        customer: {
          ...baseInvoice.data.customer,
          name: "'; DROP TABLE--",
        },
      },
    });
    expect(html).toContain("&#x27;; DROP TABLE--");
  });

  it("rejects malformed primaryColor in cssVars (no injection of arbitrary CSS)", async () => {
    const html = await buildInvoiceHtml({
      ...baseInvoice,
      snapshot: {
        ...baseSnapshot,
        primaryColor: "}body{display:none}/*",
      },
    });
    // Falls back to default — never echoes the malicious string into the style block.
    expect(html).toContain("--accent:#667eea");
    expect(html).not.toContain("display:none");
  });

  it("rejects malformed fontFamily in cssVars", async () => {
    const html = await buildInvoiceHtml({
      ...baseInvoice,
      snapshot: {
        ...baseSnapshot,
        fontFamily: "Inter';</style><script>alert(1)</script>",
      },
    });
    expect(html).toContain("--font-body:'Inter'");
    expect(html).not.toContain("</style><script>");
  });

  it("renders e-transfer block when etransferEmail is present", async () => {
    const html = await buildInvoiceHtml(baseInvoice);
    expect(html).toContain("Interac e-Transfer");
    expect(html).toContain("pay@acme.test");
    expect(html).toContain("INV-0042");
  });

  it("hides e-transfer block when etransferEmail is null", async () => {
    const html = await buildInvoiceHtml({
      ...baseInvoice,
      snapshot: { ...baseSnapshot, etransferEmail: null },
    });
    expect(html).not.toContain("Interac e-Transfer");
  });

  it("includes QR code img when payUrl is present", async () => {
    const html = await buildInvoiceHtml(baseInvoice);
    // Handlebars escapes `/` and `=` inside attributes — that's still a valid
    // attribute value (HTML entity decoding happens at parse time). Just
    // confirm the prefix is there.
    expect(html).toContain("<div class=\"qr\"><img src=\"data:image");
    expect(html).toContain(";base64,");
  });

  it("hides credit card block when payUrl is null", async () => {
    const html = await buildInvoiceHtml({
      ...baseInvoice,
      data: { ...baseInvoice.data, payUrl: null },
    });
    expect(html).not.toContain("Credit card");
  });

  it("shows surcharge note only when chargeCustomerCardFees is true", async () => {
    const off = await buildInvoiceHtml(baseInvoice);
    expect(off).not.toContain("processing fee applies");
    const on = await buildInvoiceHtml({
      ...baseInvoice,
      snapshot: { ...baseSnapshot, chargeCustomerCardFees: true },
    });
    expect(on).toContain("processing fee applies");
  });

  it("renders surcharge row on paid-by-card invoice", async () => {
    const html = await buildInvoiceHtml({
      ...baseInvoice,
      data: {
        ...baseInvoice.data,
        paidVia: "card",
        paidAt: "2026-04-26",
        surchargeAmountCents: 1044, // $10.44
      },
    });
    expect(html).toContain("Credit card fee");
    expect(html).toContain("Total charged");
    expect(html).toContain("Invoice Total");
  });

  it("hides surcharge row on cash payments", async () => {
    const html = await buildInvoiceHtml({
      ...baseInvoice,
      data: {
        ...baseInvoice.data,
        paidVia: "cash",
        paidAt: "2026-04-26",
        surchargeAmountCents: 0,
      },
    });
    expect(html).not.toContain("Credit card fee");
    expect(html).not.toContain("Total charged");
  });

  it("inlines logo data URL when present", async () => {
    // `iVBORw0KGgo` has no characters Handlebars escapes, so it round-trips literally.
    const dataUrl = "data:image/png;base64,iVBORw0KGgo";
    const html = await buildInvoiceHtml({
      ...baseInvoice,
      snapshot: { ...baseSnapshot, logo: dataUrl },
    });
    expect(html).toContain(`src="${dataUrl}"`);
  });

  it("includes CSP meta tag", async () => {
    const html = await buildInvoiceHtml(baseInvoice);
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src &#x27;none&#x27;");
  });
});

describe("quote template", () => {
  it("renders without payment block", async () => {
    const html = await buildQuoteHtml({
      snapshot: baseSnapshot,
      data: {
        quoteId: "QT-0007",
        issueDate: "2026-04-26",
        validUntil: "2026-05-26",
        status: "sent",
        customer: baseInvoice.data.customer,
        lineItems: baseInvoice.data.lineItems,
        totals: baseInvoice.data.totals,
        notes: null,
      },
    } as RenderQuoteRequest);
    expect(html).toContain("Quote");
    expect(html).toContain("QT-0007");
    expect(html).not.toContain("How to pay");
    expect(html).not.toContain("Interac e-Transfer");
  });
});
