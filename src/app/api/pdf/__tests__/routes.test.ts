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

// A snapshot logo copy as Cloud Functions writes it (D7).
const LOGO_URL =
  "https://firebasestorage.googleapis.com/v0/b/techflow-saas-prod.appspot.com/o/" +
  encodeURIComponent(`tenants/acme/snapshots/logos/${"b".repeat(64)}.png`) +
  "?alt=media&token=tok";
const LOGO_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeRequest(
  url: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, { headers });
}

function seedTenantEntitlements(tenantId: string, features: Record<string, boolean> = {}): void {
  store.set(`tenants/${tenantId}/entitlements/current`, { features });
}

function snapshot(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: "Acme",
    logoUrl: null,
    logoContentType: null,
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
    ...extra,
  };
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
    tenantSnapshot: snapshot(),
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
    tenantSnapshot: snapshot(),
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

function logoReply(): void {
  fetchMock.mockResolvedValueOnce(
    new Response(LOGO_PNG, {
      status: 200,
      headers: { "content-type": "image/png" },
    }),
  );
}

function postedBody(callIndex: number): { snapshot: Record<string, unknown>; data: Record<string, unknown> } {
  return JSON.parse((fetchMock.mock.calls[callIndex][1] as RequestInit).body as string);
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
    const body = postedBody(0);
    expect(body.snapshot.name).toBe("Acme");
    expect(body.snapshot.logo).toBeNull();
    expect(body.data.invoiceId).toBe("INV-1");
    // payUrl is built from NEXT_PUBLIC_APP_URL + payToken.
    expect(body.data.payUrl).toBe("https://app.example.test/pay/pay-tok-1");
  });

  it("D7: inlines the snapshot's logo copy for the PDF service", async () => {
    seedTenantEntitlements("acme");
    seedInvoice("acme", "INV-1", {
      tenantSnapshot: snapshot({ logoUrl: LOGO_URL, logoContentType: "image/png" }),
    });
    verifyIdToken.mockResolvedValueOnce({ uid: "u1", tenantId: "acme" });
    logoReply();
    pdfReply();

    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1", {
        authorization: "Bearer good",
      }),
    );

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(LOGO_URL);
    expect(fetchMock.mock.calls[1][0]).toBe("https://pdf.example.test/render/invoice");
    expect(postedBody(1).snapshot.logo).toBe(
      `data:image/png;base64,${LOGO_PNG.toString("base64")}`,
    );
  });

  it("D7: never fetches the logo for a caller who may not see the invoice", async () => {
    seedTenantEntitlements("acme");
    seedInvoice("acme", "INV-1", {
      tenantSnapshot: snapshot({ logoUrl: LOGO_URL, logoContentType: "image/png" }),
    });
    verifyIdToken.mockResolvedValueOnce({ uid: "u1", tenantId: "other" });

    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1", {
        authorization: "Bearer good",
      }),
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("D7: 502 when the logo copy can't be loaded, without calling the PDF service", async () => {
    seedTenantEntitlements("acme");
    seedInvoice("acme", "INV-1", {
      tenantSnapshot: snapshot({ logoUrl: LOGO_URL, logoContentType: "image/png" }),
    });
    verifyIdToken.mockResolvedValueOnce({ uid: "u1", tenantId: "acme" });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));

    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1", {
        authorization: "Bearer good",
      }),
    );

    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("D7: 409 for a logo URL outside the tenant's snapshot copies, without fetching it", async () => {
    seedTenantEntitlements("acme");
    seedInvoice("acme", "INV-1", {
      tenantSnapshot: snapshot({ logoUrl: "https://evil.example/logo.png" }),
    });
    verifyIdToken.mockResolvedValueOnce({ uid: "u1", tenantId: "acme" });

    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1", {
        authorization: "Bearer good",
      }),
    );

    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("A-12: a void invoice's PDF gets no pay link", async () => {
    seedTenantEntitlements("acme");
    seedInvoice("acme", "INV-1", { status: "void" });
    verifyIdToken.mockResolvedValueOnce({ uid: "u1", tenantId: "acme" });
    pdfReply();

    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1", {
        authorization: "Bearer good",
      }),
    );
    expect(res.status).toBe(200);
    const body = postedBody(0);
    expect(body.data.status).toBe("void");
    expect(body.data.payUrl).toBeNull();
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

  it("D7: inlines the snapshot's logo copy for the PDF service", async () => {
    seedTenantEntitlements("acme");
    seedQuote("acme", "QT-1", {
      tenantSnapshot: snapshot({ logoUrl: LOGO_URL, logoContentType: "image/png" }),
    });
    verifyIdToken.mockResolvedValueOnce({ uid: "u1", tenantId: "acme" });
    logoReply();
    pdfReply();

    const res = await quoteGET(
      makeRequest("https://app.example.test/api/pdf/quote?tenantId=acme&quoteId=QT-1", {
        authorization: "Bearer good",
      }),
    );

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(LOGO_URL);
    expect(postedBody(1).snapshot.logo).toBe(
      `data:image/png;base64,${LOGO_PNG.toString("base64")}`,
    );
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

describe("S-08: customers never get a draft's PDF (A-05)", () => {
  const customer = { uid: "cust1", email: "jane@example.com", email_verified: true };

  it("404 for a draft invoice, without calling the PDF service", async () => {
    seedTenantEntitlements("acme");
    seedInvoice("acme", "INV-1", { status: "draft" });
    verifyIdToken.mockResolvedValueOnce(customer);

    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1", {
        authorization: "Bearer good",
      }),
    );

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404 for a draft quote, without calling the PDF service", async () => {
    seedTenantEntitlements("acme");
    seedQuote("acme", "QT-1", { status: "draft" });
    verifyIdToken.mockResolvedValueOnce(customer);

    const res = await quoteGET(
      makeRequest("https://app.example.test/api/pdf/quote?tenantId=acme&quoteId=QT-1", {
        authorization: "Bearer good",
      }),
    );

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the business still gets its own draft's PDF", async () => {
    seedTenantEntitlements("acme");
    seedInvoice("acme", "INV-1", { status: "draft" });
    verifyIdToken.mockResolvedValueOnce({ uid: "u1", tenantId: "acme" });
    pdfReply();

    const res = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1", {
        authorization: "Bearer good",
      }),
    );

    expect(res.status).toBe(200);
  });

  it("a customer still gets a void invoice's PDF, and a converted quote's", async () => {
    seedTenantEntitlements("acme");
    seedInvoice("acme", "INV-1", { status: "void" });
    seedQuote("acme", "QT-1", { status: "converted" });
    verifyIdToken.mockResolvedValue(customer);
    pdfReply();
    pdfReply();

    const invoiceRes = await invoiceGET(
      makeRequest("https://app.example.test/api/pdf/invoice?tenantId=acme&invoiceId=INV-1", {
        authorization: "Bearer good",
      }),
    );
    const quoteRes = await quoteGET(
      makeRequest("https://app.example.test/api/pdf/quote?tenantId=acme&quoteId=QT-1", {
        authorization: "Bearer good",
      }),
    );

    expect(invoiceRes.status).toBe(200);
    expect(quoteRes.status).toBe(200);
  });
});
