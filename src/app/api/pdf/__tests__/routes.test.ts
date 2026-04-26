import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory Firestore stand-in. Mirrors the pattern in src/app/api/webhooks/
// stripe/__tests__/webhooks.test.ts.
// ---------------------------------------------------------------------------

const store = new Map<string, Record<string, unknown> | null>();

function makeDocRef(path: string) {
  return {
    path,
    get: vi.fn(async () => {
      const data = store.get(path);
      return { exists: data != null, data: () => data ?? undefined };
    }),
  };
}

const fakeDb = { doc: vi.fn((path: string) => makeDocRef(path)) };

const verifyIdToken = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => fakeDb,
  getAdminAuth: () => ({ verifyIdToken }),
}));

const ORIGINAL_FETCH = globalThis.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
  store.clear();
  verifyIdToken.mockReset();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as typeof fetch;
  process.env.PDF_SERVICE_URL = "https://pdf.example.test";
  process.env.PDF_SERVICE_API_KEY = "secret-key";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.PDF_SERVICE_URL;
  delete process.env.PDF_SERVICE_API_KEY;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

import { GET as invoiceGET } from "../invoice/route";
import { GET as quoteGET } from "../quote/route";

function makeRequest(
  url: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, { headers });
}

function seedTenantEntitlements(tenantId: string, features: Record<string, boolean> = {}): void {
  store.set(`tenants/${tenantId}/entitlements/current`, { features });
}

function seedInvoice(
  tenantId: string,
  invoiceId: string,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  store.set(`tenants/${tenantId}/invoices/${invoiceId}`, {
    customer: { name: "Jane", email: "jane@example.com", phone: null },
    lineItems: [{ description: "x", quantity: 1, rate: 1, amount: 1 }],
    totals: { subtotal: 1, taxRate: 0, taxAmount: 0, total: 1 },
    tenantSnapshot: {
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
    status: "sent",
    issueDate: "2026-04-26",
    dueDate: "2026-05-26",
    notes: null,
    payToken: "pay-tok-1",
    ...overrides,
  });
}

function seedQuote(
  tenantId: string,
  quoteId: string,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  store.set(`tenants/${tenantId}/quotes/${quoteId}`, {
    customer: { name: "Jane", email: "jane@example.com", phone: null },
    lineItems: [{ description: "x", quantity: 1, rate: 1, amount: 1 }],
    totals: { subtotal: 1, taxRate: 0, taxAmount: 0, total: 1 },
    tenantSnapshot: {
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
    status: "sent",
    issueDate: "2026-04-26",
    validUntil: "2026-05-26",
    notes: null,
    ...overrides,
  });
}

function pdfReply(): void {
  fetchMock.mockResolvedValueOnce(
    new Response(Buffer.from("%PDF-1.4 test"), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    }),
  );
}

describe("GET /api/pdf/invoice", () => {
  it("400 when tenantId is missing", async () => {
    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?invoiceId=INV-1"),
    );
    expect(res.status).toBe(400);
  });

  it("401 when Authorization header is missing", async () => {
    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1"),
    );
    expect(res.status).toBe(401);
  });

  it("401 when ID token is invalid", async () => {
    verifyIdToken.mockRejectedValueOnce(new Error("expired"));
    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1", {
        authorization: "Bearer bad",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("404 when invoice does not exist", async () => {
    seedTenantEntitlements("acme");
    verifyIdToken.mockResolvedValueOnce({ uid: "u1", tenantId: "acme" });
    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=missing", {
        authorization: "Bearer good",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("403 when tenant token does not match invoice tenantId", async () => {
    seedTenantEntitlements("acme");
    seedInvoice("acme", "INV-1");
    verifyIdToken.mockResolvedValueOnce({ uid: "u1", tenantId: "other" });
    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1", {
        authorization: "Bearer good",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("403 when customer email mismatches invoice email", async () => {
    seedTenantEntitlements("acme");
    seedInvoice("acme", "INV-1");
    verifyIdToken.mockResolvedValueOnce({
      uid: "u1",
      email: "stranger@example.com",
      email_verified: true,
    });
    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1", {
        authorization: "Bearer good",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("200 + streams PDF for tenant token", async () => {
    seedTenantEntitlements("acme");
    seedInvoice("acme", "INV-1");
    verifyIdToken.mockResolvedValueOnce({ uid: "u1", tenantId: "acme" });
    pdfReply();

    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1", {
        authorization: "Bearer good",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://pdf.example.test/render/invoice");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("x-api-key")).toBe("secret-key");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.snapshot.name).toBe("Acme");
    expect(body.data.invoiceId).toBe("INV-1");
    // payUrl is built from NEXT_PUBLIC_APP_URL + payToken.
    expect(body.data.payUrl).toBe("https://app.example.test/pay/pay-tok-1");
  });

  it("200 for matching customer email (case-insensitive)", async () => {
    seedTenantEntitlements("acme");
    seedInvoice("acme", "INV-1");
    verifyIdToken.mockResolvedValueOnce({
      uid: "cust1",
      email: "JANE@example.COM",
      email_verified: true,
    });
    pdfReply();

    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1", {
        authorization: "Bearer good",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("403 when invoices feature is disabled for the tenant", async () => {
    seedTenantEntitlements("acme", { invoices: false });
    seedInvoice("acme", "INV-1");
    verifyIdToken.mockResolvedValueOnce({ uid: "u1", tenantId: "acme" });
    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1", {
        authorization: "Bearer good",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("502 when pdf-service is unreachable", async () => {
    seedTenantEntitlements("acme");
    seedInvoice("acme", "INV-1");
    verifyIdToken.mockResolvedValueOnce({ uid: "u1", tenantId: "acme" });
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1", {
        authorization: "Bearer good",
      }),
    );
    expect(res.status).toBe(502);
  });

  it("does not forward Authorization to Cloud Run", async () => {
    seedTenantEntitlements("acme");
    seedInvoice("acme", "INV-1");
    verifyIdToken.mockResolvedValueOnce({ uid: "u1", tenantId: "acme" });
    pdfReply();
    await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1", {
        authorization: "Bearer good",
      }),
    );
    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get("authorization")).toBeNull();
  });
});

describe("GET /api/pdf/quote", () => {
  it("200 + streams PDF for tenant token", async () => {
    seedTenantEntitlements("acme");
    seedQuote("acme", "QT-1");
    verifyIdToken.mockResolvedValueOnce({ uid: "u1", tenantId: "acme" });
    pdfReply();

    const res = await quoteGET(
      makeRequest("https://app.example.test/api/pdf/quote?tenantId=acme&quoteId=QT-1", {
        authorization: "Bearer good",
      }),
    );
    expect(res.status).toBe(200);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://pdf.example.test/render/quote");
  });

  it("404 when quote does not exist", async () => {
    seedTenantEntitlements("acme");
    verifyIdToken.mockResolvedValueOnce({ uid: "u1", tenantId: "acme" });
    const res = await quoteGET(
      makeRequest("https://app.example.test/api/pdf/quote?tenantId=acme&quoteId=missing", {
        authorization: "Bearer good",
      }),
    );
    expect(res.status).toBe(404);
  });
});
