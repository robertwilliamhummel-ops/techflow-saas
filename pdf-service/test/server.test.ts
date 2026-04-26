import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

const TEST_KEY = "test-pdf-service-key";

vi.mock("../src/renderInvoice", () => ({
  renderInvoicePDF: vi.fn(async () => Buffer.from("%PDF-1.4 fake")),
}));
vi.mock("../src/renderQuote", () => ({
  renderQuotePDF: vi.fn(async () => Buffer.from("%PDF-1.4 fake")),
}));
vi.mock("../src/browser", () => ({
  closeBrowser: vi.fn(async () => undefined),
}));

let app: import("express").Express;

beforeAll(async () => {
  process.env.PDF_SERVICE_API_KEY = TEST_KEY;
  app = (await import("../src/index")).app;
});

afterAll(() => {
  delete process.env.PDF_SERVICE_API_KEY;
});

const validBody = {
  snapshot: {
    version: 1,
    name: "Acme",
    logo: null,
    address: null,
    primaryColor: "#667eea",
    secondaryColor: "#764ba2",
    fontFamily: "Inter",
    faviconUrl: null,
    taxRate: 0,
    taxName: "",
    businessNumber: null,
    emailFooter: null,
    currency: "CAD",
    chargeCustomerCardFees: false,
    cardFeePercent: 0,
    etransferEmail: null,
  },
  data: {
    invoiceId: "INV-0001",
    issueDate: "2026-04-26",
    dueDate: "2026-05-26",
    status: "sent",
    customer: { name: "Jane", email: "j@x.com", phone: null },
    lineItems: [{ description: "x", quantity: 1, rate: 1, amount: 1 }],
    totals: { subtotal: 1, taxRate: 0, taxAmount: 0, total: 1 },
    notes: null,
  },
};

describe("pdf-service server", () => {
  it("/healthz is open (no auth)", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects render request without X-Api-Key", async () => {
    const res = await request(app)
      .post("/render/invoice")
      .send(validBody);
    expect(res.status).toBe(401);
  });

  it("rejects render request with wrong X-Api-Key", async () => {
    const res = await request(app)
      .post("/render/invoice")
      .set("X-Api-Key", "wrong")
      .send(validBody);
    expect(res.status).toBe(401);
  });

  it("renders invoice with correct X-Api-Key", async () => {
    const res = await request(app)
      .post("/render/invoice")
      .set("X-Api-Key", TEST_KEY)
      .send(validBody);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toContain("INV-0001.pdf");
  });

  it("returns 400 on malformed body even with valid key", async () => {
    const res = await request(app)
      .post("/render/invoice")
      .set("X-Api-Key", TEST_KEY)
      .send({ snapshot: null, data: null });
    expect(res.status).toBe(400);
  });

  it("renders quote with correct X-Api-Key", async () => {
    const res = await request(app)
      .post("/render/quote")
      .set("X-Api-Key", TEST_KEY)
      .send({
        snapshot: validBody.snapshot,
        data: {
          quoteId: "QT-0001",
          issueDate: "2026-04-26",
          validUntil: "2026-05-26",
          status: "sent",
          customer: validBody.data.customer,
          lineItems: validBody.data.lineItems,
          totals: validBody.data.totals,
          notes: null,
        },
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("QT-0001.pdf");
  });
});
