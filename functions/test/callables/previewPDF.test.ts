import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be set before handler imports.
// ---------------------------------------------------------------------------
const TEST_API_KEY = "test-pdf-api-key";

vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({
    value: () => {
      if (name === "PDF_SERVICE_API_KEY") return TEST_API_KEY;
      return "mock-secret";
    },
  }),
}));

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { clearFirestore, fakeRequest, testDb } from "./_setup";
import { FieldValue } from "firebase-admin/firestore";
import { previewInvoicePDFHandler } from "../../src/invoices/previewInvoicePDF";
import { previewQuotePDFHandler } from "../../src/quotes/previewQuotePDF";

const TENANT = "acme-pdf";
const OWNER_UID = "u_owner";

const ownerAuth = {
  uid: OWNER_UID,
  claims: {
    email: "owner@acme.test",
    tenantId: TENANT,
    role: "owner" as const,
  },
};

const ORIGINAL_FETCH = globalThis.fetch;
const fetchMock = vi.fn();

const PDF_BYTES = Buffer.from("%PDF-1.4 fake-pdf-bytes");

function pdfReply(): void {
  fetchMock.mockResolvedValueOnce(
    new Response(PDF_BYTES, {
      status: 200,
      headers: { "content-type": "application/pdf" },
    }),
  );
}

beforeEach(async () => {
  await clearFirestore();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as typeof fetch;
  process.env.PDF_SERVICE_URL = "https://pdf.example.test";
  process.env.APP_URL = "https://portal.example.test";

  // Seed entitlements (invoices + quotes default-on; we just need the doc to
  // exist so requireFeature doesn't fail).
  await testDb.doc(`tenants/${TENANT}/entitlements/current`).set({
    plan: "starter",
    features: {},
    updatedAt: FieldValue.serverTimestamp(),
  });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.PDF_SERVICE_URL;
  delete process.env.APP_URL;
});

const SNAPSHOT = {
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
};

async function seedInvoice(
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await testDb.doc(`tenants/${TENANT}/invoices/INV-1`).set({
    customer: { name: "Jane", email: "jane@example.com", phone: null },
    lineItems: [{ description: "x", quantity: 1, rate: 1, amount: 1 }],
    totals: { subtotal: 1, taxRate: 0, taxAmount: 0, total: 1 },
    tenantSnapshot: SNAPSHOT,
    status: "sent",
    issueDate: "2026-04-26",
    dueDate: "2026-05-26",
    notes: null,
    payToken: "pay-tok-1",
    ...overrides,
  });
}

async function seedQuote(
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await testDb.doc(`tenants/${TENANT}/quotes/QT-1`).set({
    customer: { name: "Jane", email: "jane@example.com", phone: null },
    lineItems: [{ description: "x", quantity: 1, rate: 1, amount: 1 }],
    totals: { subtotal: 1, taxRate: 0, taxAmount: 0, total: 1 },
    tenantSnapshot: SNAPSHOT,
    status: "sent",
    issueDate: "2026-04-26",
    validUntil: "2026-05-26",
    notes: null,
    ...overrides,
  });
}

describe("previewInvoicePDF", () => {
  it("rejects unauthenticated callers", async () => {
    await expect(
      previewInvoicePDFHandler(fakeRequest({ invoiceId: "INV-1" }, null)),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejects callers without tenantId claim", async () => {
    await expect(
      previewInvoicePDFHandler(
        fakeRequest({ invoiceId: "INV-1" }, {
          uid: "u",
          claims: { email: "x@y.com", role: "owner" } as never,
        }),
      ),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("rejects when invoiceId missing", async () => {
    await expect(
      previewInvoicePDFHandler(fakeRequest({}, ownerAuth)),
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("404 when invoice doc does not exist", async () => {
    await expect(
      previewInvoicePDFHandler(
        fakeRequest({ invoiceId: "missing" }, ownerAuth),
      ),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("returns base64 PDF on success", async () => {
    await seedInvoice();
    pdfReply();
    const result = await previewInvoicePDFHandler(
      fakeRequest({ invoiceId: "INV-1" }, ownerAuth),
    );
    expect(result.contentType).toBe("application/pdf");
    expect(result.filename).toBe("INV-1.pdf");
    expect(Buffer.from(result.pdfBase64, "base64").toString()).toBe(
      PDF_BYTES.toString(),
    );
  });

  it("forwards x-api-key and posts the snapshot+data payload", async () => {
    await seedInvoice();
    pdfReply();
    await previewInvoicePDFHandler(
      fakeRequest({ invoiceId: "INV-1" }, ownerAuth),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://pdf.example.test/render/invoice");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("x-api-key")).toBe(TEST_API_KEY);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.snapshot.name).toBe("Acme");
    expect(body.data.invoiceId).toBe("INV-1");
    expect(body.data.payUrl).toBe("https://portal.example.test/pay/pay-tok-1");
  });

  it("payUrl is null when invoice has no payToken", async () => {
    await seedInvoice({ payToken: null });
    pdfReply();
    await previewInvoicePDFHandler(
      fakeRequest({ invoiceId: "INV-1" }, ownerAuth),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.data.payUrl).toBeNull();
  });

  it("maps Cloud Run unreachable to 'unavailable'", async () => {
    await seedInvoice();
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      previewInvoicePDFHandler(
        fakeRequest({ invoiceId: "INV-1" }, ownerAuth),
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("maps Cloud Run 401 to 'internal' (proxy auth, not user auth)", async () => {
    await seedInvoice();
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"Unauthorized"}', { status: 401 }),
    );
    await expect(
      previewInvoicePDFHandler(
        fakeRequest({ invoiceId: "INV-1" }, ownerAuth),
      ),
    ).rejects.toMatchObject({ code: "internal" });
  });

  it("rejects when invoice is missing tenantSnapshot", async () => {
    await testDb.doc(`tenants/${TENANT}/invoices/INV-1`).set({
      customer: { name: "Jane", email: "jane@example.com", phone: null },
      lineItems: [],
      totals: {},
      status: "draft",
      issueDate: "2026-04-26",
      dueDate: "2026-05-26",
    });
    await expect(
      previewInvoicePDFHandler(
        fakeRequest({ invoiceId: "INV-1" }, ownerAuth),
      ),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("rejects when PDF_SERVICE_URL is missing", async () => {
    delete process.env.PDF_SERVICE_URL;
    await seedInvoice();
    await expect(
      previewInvoicePDFHandler(
        fakeRequest({ invoiceId: "INV-1" }, ownerAuth),
      ),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });
});

describe("previewQuotePDF", () => {
  it("returns base64 PDF on success", async () => {
    await seedQuote();
    pdfReply();
    const result = await previewQuotePDFHandler(
      fakeRequest({ quoteId: "QT-1" }, ownerAuth),
    );
    expect(result.contentType).toBe("application/pdf");
    expect(result.filename).toBe("QT-1.pdf");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://pdf.example.test/render/quote");
  });

  it("404 when quote does not exist", async () => {
    await expect(
      previewQuotePDFHandler(
        fakeRequest({ quoteId: "missing" }, ownerAuth),
      ),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("rejects when quoteId missing", async () => {
    await expect(
      previewQuotePDFHandler(fakeRequest({}, ownerAuth)),
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("rejects callers without tenantId claim", async () => {
    await expect(
      previewQuotePDFHandler(
        fakeRequest({ quoteId: "QT-1" }, {
          uid: "u",
          claims: { email: "x@y.com", role: "owner" } as never,
        }),
      ),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});
