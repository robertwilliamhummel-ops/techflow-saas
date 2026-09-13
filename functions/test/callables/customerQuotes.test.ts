// P-06 — getCustomerQuotes + getCustomerQuoteDetail: the customer portal's
// quote list and quote page, with the same visibility rules as invoices (A-05).

import { beforeEach, describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { clearFirestore, fakeRequest, testDb } from "./_setup";
import { CUSTOMER_VISIBLE_QUOTE_STATUSES } from "../../src/shared/customerVisibility";
import {
  getCustomerQuotesHandler,
  listCustomerQuotes,
} from "../../src/portal/getCustomerQuotes";
import { getCustomerQuoteDetailHandler } from "../../src/portal/getCustomerQuoteDetail";

const TENANT = "acme-plumbing";
const OTHER_TENANT = "bright-electric";
const CUSTOMER_EMAIL = "jane@example.com";

function customer(email = CUSTOMER_EMAIL) {
  return { uid: "u_customer", claims: { email, email_verified: true } };
}

interface QuoteSeed {
  tenantId?: string;
  status?: string;
  createdAtMs?: number;
  email?: string;
  logo?: string | null;
  logoUrl?: string | null;
}

async function seedQuote(id: string, seed: QuoteSeed = {}): Promise<void> {
  const tenantId = seed.tenantId ?? TENANT;
  await testDb.doc(`tenants/${tenantId}/quotes/${id}`).set({
    customer: { name: "Jane Doe", email: seed.email ?? CUSTOMER_EMAIL, phone: null },
    lineItems: [{ description: "Estimate", quantity: 1, rate: 200, amount: 200 }],
    applyTax: true,
    totals: { subtotal: 200, taxRate: 0.13, taxAmount: 26, total: 226 },
    tenantSnapshot: {
      version: 1,
      name: tenantId === TENANT ? "Acme Plumbing" : "Bright Electric",
      logo: seed.logo ?? null,
      logoUrl: seed.logoUrl ?? null,
      primaryColor: "#123456",
    },
    status: seed.status ?? "sent",
    validUntil: "2026-10-31",
    issueDate: "2026-09-01",
    notes: "Valid for 30 days",
    createdAt: Timestamp.fromMillis(seed.createdAtMs ?? Date.now()),
    createdBy: "u_owner",
  });
}

describe("getCustomerQuotes (P-06)", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("lists the customer's quotes from every business, newest first", async () => {
    const now = Date.now();
    await seedQuote("QT-0001", { createdAtMs: now - 2_000 });
    await seedQuote("QT-0007", {
      tenantId: OTHER_TENANT,
      status: "accepted",
      createdAtMs: now - 1_000,
    });
    await seedQuote("QT-0002", { email: "someone@else.com", createdAtMs: now });

    const { quotes } = await getCustomerQuotesHandler(fakeRequest({}, customer()));

    expect(quotes.map((q) => [q.tenantId, q.id])).toEqual([
      [OTHER_TENANT, "QT-0007"],
      [TENANT, "QT-0001"],
    ]);
    expect(quotes[1]).toEqual({
      id: "QT-0001",
      path: `tenants/${TENANT}/quotes/QT-0001`,
      tenantId: TENANT,
      customer: { name: "Jane Doe", email: CUSTOMER_EMAIL },
      totals: { subtotal: 200, taxAmount: 26, total: 226 },
      status: "sent",
      validUntil: "2026-10-31",
      issueDate: "2026-09-01",
      tenantBranding: {
        name: "Acme Plumbing",
        logoUrl: null,
        primaryColor: "#123456",
      },
    });
  });

  it("matches the verified email case-insensitively", async () => {
    await seedQuote("QT-0001");
    const { quotes } = await getCustomerQuotesHandler(
      fakeRequest({}, customer("Jane@Example.COM")),
    );
    expect(quotes.map((q) => q.id)).toEqual(["QT-0001"]);
  });

  it("never lists drafts, and lists every customer-visible status", async () => {
    const now = Date.now();
    await seedQuote("QT-DRAFT", { status: "draft", createdAtMs: now });
    for (const [i, status] of CUSTOMER_VISIBLE_QUOTE_STATUSES.entries()) {
      await seedQuote(`QT-${i}`, { status, createdAtMs: now - (i + 1) * 1_000 });
    }

    const { quotes } = await getCustomerQuotesHandler(fakeRequest({}, customer()));

    expect(quotes.map((q) => q.status)).toEqual([...CUSTOMER_VISIBLE_QUOTE_STATUSES]);
  });

  it("rows carry the snapshot logo URL, never the inlined base64 logo", async () => {
    await seedQuote("QT-0001", {
      logo: "data:image/png;base64,iVBORw0KGgo=",
      logoUrl: "https://storage.example.com/logo.png",
    });

    const result = await getCustomerQuotesHandler(fakeRequest({}, customer()));

    expect(result.quotes[0].tenantBranding.logoUrl).toBe(
      "https://storage.example.com/logo.png",
    );
    expect(JSON.stringify(result)).not.toContain("base64");
  });

  it("keeps paging past drafts until the list is full", async () => {
    const now = Date.now();
    await seedQuote("QT-A", { createdAtMs: now });
    await seedQuote("QT-D1", { status: "draft", createdAtMs: now - 1_000 });
    await seedQuote("QT-D2", { status: "draft", createdAtMs: now - 2_000 });
    await seedQuote("QT-D3", { status: "draft", createdAtMs: now - 3_000 });
    await seedQuote("QT-B", { status: "declined", createdAtMs: now - 4_000 });
    await seedQuote("QT-C", { status: "expired", createdAtMs: now - 5_000 });

    const items = await listCustomerQuotes(CUSTOMER_EMAIL, { limit: 3, pageSize: 2 });

    expect(items.map((item) => item.id)).toEqual(["QT-A", "QT-B", "QT-C"]);
  });

  it("rejects unauthenticated callers and unverified emails", async () => {
    await expect(
      getCustomerQuotesHandler(fakeRequest({}, null)),
    ).rejects.toThrow(/Sign in required/);
    await expect(
      getCustomerQuotesHandler(
        fakeRequest({}, { uid: "u_unverified", claims: { email: CUSTOMER_EMAIL } }),
      ),
    ).rejects.toThrow(/Verified email required/);
  });
});

describe("getCustomerQuoteDetail (P-06)", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("returns the quote to the customer it was sent to", async () => {
    await seedQuote("QT-0001");

    const quote = await getCustomerQuoteDetailHandler(
      fakeRequest({ tenantId: TENANT, quoteId: "QT-0001" }, customer("JANE@example.com")),
    );

    expect(quote).toMatchObject({
      id: "QT-0001",
      tenantId: TENANT,
      status: "sent",
      validUntil: "2026-10-31",
      notes: "Valid for 30 days",
      totals: { total: 226 },
    });
  });

  it("refuses another customer's quote", async () => {
    await seedQuote("QT-0001");
    await expect(
      getCustomerQuoteDetailHandler(
        fakeRequest(
          { tenantId: TENANT, quoteId: "QT-0001" },
          customer("other@example.com"),
        ),
      ),
    ).rejects.toThrow(/Not your quote/);
  });

  it("answers not-found for a draft, even for the matching customer", async () => {
    await seedQuote("QT-0001", { status: "draft" });
    await expect(
      getCustomerQuoteDetailHandler(
        fakeRequest({ tenantId: TENANT, quoteId: "QT-0001" }, customer()),
      ),
    ).rejects.toThrow(/Quote not found/);
  });

  it("answers not-found for an unknown quote", async () => {
    await expect(
      getCustomerQuoteDetailHandler(
        fakeRequest({ tenantId: TENANT, quoteId: "QT-9999" }, customer()),
      ),
    ).rejects.toThrow(/Quote not found/);
  });

  it("validates the tenant and quote ids", async () => {
    await expect(
      getCustomerQuoteDetailHandler(fakeRequest({ quoteId: "QT-0001" }, customer())),
    ).rejects.toThrow(/tenantId required/);
    await expect(
      getCustomerQuoteDetailHandler(
        fakeRequest({ tenantId: TENANT, quoteId: "QT-0001/x/y" }, customer()),
      ),
    ).rejects.toThrow(/quoteId is invalid/);
  });

  it("rejects an unverified email", async () => {
    await seedQuote("QT-0001");
    await expect(
      getCustomerQuoteDetailHandler(
        fakeRequest(
          { tenantId: TENANT, quoteId: "QT-0001" },
          { uid: "u_unverified", claims: { email: CUSTOMER_EMAIL } },
        ),
      ),
    ).rejects.toThrow(/Verified email required/);
  });
});
