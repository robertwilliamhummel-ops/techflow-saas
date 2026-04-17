import { beforeEach, describe, expect, it, vi } from "vitest";
import { verify } from "jsonwebtoken";

// ---------------------------------------------------------------------------
// Mock defineSecret — convertQuoteToInvoice uses PAY_TOKEN_SECRET.
// ---------------------------------------------------------------------------
const TEST_SECRET = "test-pay-token-secret-256bit-min!!";

vi.mock("firebase-functions/params", () => ({
  defineSecret: () => ({ value: () => TEST_SECRET }),
}));

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { clearFirestore, fakeRequest, testDb } from "./_setup";
import { FieldValue } from "firebase-admin/firestore";

import { createQuoteHandler } from "../../src/quotes/createQuote";
import { updateQuoteHandler } from "../../src/quotes/updateQuote";
import { deleteQuoteHandler } from "../../src/quotes/deleteQuote";
import { convertQuoteToInvoiceHandler } from "../../src/quotes/convertQuoteToInvoice";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT = "acme-plumbing";
const OWNER_UID = "u_owner";

const ownerAuth = {
  uid: OWNER_UID,
  claims: {
    email: "owner@acme.test",
    tenantId: TENANT,
    role: "owner" as const,
  },
};

const staffAuth = {
  uid: "u_staff",
  claims: {
    email: "staff@acme.test",
    tenantId: TENANT,
    role: "staff" as const,
  },
};

function validQuoteData(overrides: Record<string, unknown> = {}) {
  return {
    customer: {
      name: "Bob Builder",
      email: "Bob@Example.COM",
      phone: "555-9876",
    },
    lineItems: [
      { description: "Bathroom reno estimate", quantity: 1, rate: 5000 },
      { description: "Materials", quantity: 10, rate: 45 },
    ],
    applyTax: true,
    validUntil: "2026-06-30",
    notes: "Valid for 30 days",
    ...overrides,
  };
}

async function seedTenant(): Promise<void> {
  const batch = testDb.batch();
  batch.set(testDb.doc(`tenants/${TENANT}/meta/settings`), {
    name: "Acme Plumbing",
    logoUrl: null,
    address: "123 Main St",
    primaryColor: "#667eea",
    secondaryColor: "#764ba2",
    fontFamily: "Inter",
    faviconUrl: null,
    taxRate: 0.13,
    taxName: "HST",
    businessNumber: "123456789",
    invoicePrefix: "INV",
    emailFooter: null,
    currency: "CAD",
    etransferEmail: "pay@acme.test",
    chargeCustomerCardFees: false,
    cardFeePercent: 2.4,
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(testDb.doc(`tenants/${TENANT}/entitlements/current`), {
    plan: "starter",
    features: {},
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(testDb.doc(`tenants/${TENANT}/counters/quote`), {
    value: 0,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(testDb.doc(`tenants/${TENANT}/counters/invoice`), {
    value: 0,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
}

// ---------------------------------------------------------------------------
// createQuote
// ---------------------------------------------------------------------------

describe("createQuote", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTenant();
  });

  it("happy path — creates quote with correct ID, counter, snapshot, totals", async () => {
    const result = await createQuoteHandler(
      fakeRequest(validQuoteData(), ownerAuth),
    );

    expect(result.quoteId).toBe("QT-0001");

    // Counter incremented
    const counter = await testDb
      .doc(`tenants/${TENANT}/counters/quote`)
      .get();
    expect(counter.data()?.value).toBe(1);

    // Quote doc
    const qt = await testDb
      .doc(`tenants/${TENANT}/quotes/QT-0001`)
      .get();
    expect(qt.exists).toBe(true);
    const data = qt.data()!;

    // Customer email lowercased (C2)
    expect(data.customer.email).toBe("bob@example.com");
    expect(data.customer.name).toBe("Bob Builder");

    // Status
    expect(data.status).toBe("draft");

    // Server-computed totals: (1×5000 + 10×45) = 5450 subtotal, 13% = 708.50
    expect(data.totals.subtotal).toBe(5450);
    expect(data.totals.taxRate).toBe(0.13);
    expect(data.totals.taxAmount).toBe(708.5);
    expect(data.totals.total).toBe(6158.5);

    // Line items have server-computed amounts
    expect(data.lineItems).toHaveLength(2);
    expect(data.lineItems[0].amount).toBe(5000);
    expect(data.lineItems[1].amount).toBe(450);

    // Frozen tenantSnapshot
    expect(data.tenantSnapshot.version).toBe(1);
    expect(data.tenantSnapshot.name).toBe("Acme Plumbing");
    expect(data.tenantSnapshot.taxRate).toBe(0.13);
    expect(data.tenantSnapshot.currency).toBe("CAD");

    // No pay token on quotes
    expect(data.payToken).toBeUndefined();
    expect(data.payTokenVersion).toBeUndefined();
  });

  it("atomic counter — sequential creates produce QT-0001, QT-0002, QT-0003", async () => {
    const r1 = await createQuoteHandler(
      fakeRequest(validQuoteData(), ownerAuth),
    );
    const r2 = await createQuoteHandler(
      fakeRequest(validQuoteData(), ownerAuth),
    );
    const r3 = await createQuoteHandler(
      fakeRequest(validQuoteData(), ownerAuth),
    );

    expect(r1.quoteId).toBe("QT-0001");
    expect(r2.quoteId).toBe("QT-0002");
    expect(r3.quoteId).toBe("QT-0003");

    const counter = await testDb
      .doc(`tenants/${TENANT}/counters/quote`)
      .get();
    expect(counter.data()?.value).toBe(3);
  });

  it("frozen snapshot preserves branding at creation time", async () => {
    await createQuoteHandler(fakeRequest(validQuoteData(), ownerAuth));

    // Change branding
    await testDb.doc(`tenants/${TENANT}/meta/settings`).update({
      name: "Acme HVAC",
      primaryColor: "#ff0000",
    });

    await createQuoteHandler(fakeRequest(validQuoteData(), ownerAuth));

    const qt1 = (
      await testDb.doc(`tenants/${TENANT}/quotes/QT-0001`).get()
    ).data()!;
    expect(qt1.tenantSnapshot.name).toBe("Acme Plumbing");
    expect(qt1.tenantSnapshot.primaryColor).toBe("#667eea");

    const qt2 = (
      await testDb.doc(`tenants/${TENANT}/quotes/QT-0002`).get()
    ).data()!;
    expect(qt2.tenantSnapshot.name).toBe("Acme HVAC");
    expect(qt2.tenantSnapshot.primaryColor).toBe("#ff0000");
  });

  it("rejects unauthenticated caller", async () => {
    await expect(
      createQuoteHandler(fakeRequest(validQuoteData(), null)),
    ).rejects.toThrow(/Sign in required/);
  });

  it("rejects missing validUntil", async () => {
    await expect(
      createQuoteHandler(
        fakeRequest(validQuoteData({ validUntil: "" }), ownerAuth),
      ),
    ).rejects.toThrow(/validUntil required/);
  });

  it("rejects when quotes feature is disabled", async () => {
    await testDb.doc(`tenants/${TENANT}/entitlements/current`).update({
      features: { quotes: false },
    });

    await expect(
      createQuoteHandler(fakeRequest(validQuoteData(), ownerAuth)),
    ).rejects.toThrow(/Feature 'quotes' is not enabled/);
  });
});

// ---------------------------------------------------------------------------
// updateQuote
// ---------------------------------------------------------------------------

describe("updateQuote", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTenant();
  });

  it("updates mutable fields and recomputes totals from frozen snapshot", async () => {
    const { quoteId } = await createQuoteHandler(
      fakeRequest(validQuoteData(), ownerAuth),
    );

    // Change meta taxRate — update should use frozen snapshot, not this
    await testDb
      .doc(`tenants/${TENANT}/meta/settings`)
      .update({ taxRate: 0.2 });

    await updateQuoteHandler(
      fakeRequest(
        {
          quoteId,
          customer: { name: "Bob Updated", email: "BOB@NEW.COM" },
          lineItems: [{ description: "Full reno", quantity: 1, rate: 10000 }],
          applyTax: true,
          validUntil: "2026-07-31",
        },
        ownerAuth,
      ),
    );

    const qt = (
      await testDb.doc(`tenants/${TENANT}/quotes/${quoteId}`).get()
    ).data()!;

    expect(qt.customer.email).toBe("bob@new.com");
    expect(qt.customer.name).toBe("Bob Updated");

    // Totals use frozen snapshot taxRate (0.13)
    expect(qt.totals.subtotal).toBe(10000);
    expect(qt.totals.taxRate).toBe(0.13);
    expect(qt.totals.taxAmount).toBe(1300);
    expect(qt.totals.total).toBe(11300);

    // Snapshot NOT changed
    expect(qt.tenantSnapshot.name).toBe("Acme Plumbing");
  });

  it("rejects update on a converted quote", async () => {
    const { quoteId } = await createQuoteHandler(
      fakeRequest(validQuoteData(), ownerAuth),
    );
    await testDb
      .doc(`tenants/${TENANT}/quotes/${quoteId}`)
      .update({ status: "converted" });

    await expect(
      updateQuoteHandler(
        fakeRequest({ ...validQuoteData(), quoteId }, ownerAuth),
      ),
    ).rejects.toThrow(/Cannot update a converted quote/);
  });

  it("rejects when quote does not exist", async () => {
    await expect(
      updateQuoteHandler(
        fakeRequest({ ...validQuoteData(), quoteId: "QT-9999" }, ownerAuth),
      ),
    ).rejects.toThrow(/Quote not found/);
  });
});

// ---------------------------------------------------------------------------
// deleteQuote
// ---------------------------------------------------------------------------

describe("deleteQuote", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTenant();
  });

  it("owner can delete a draft quote", async () => {
    const { quoteId } = await createQuoteHandler(
      fakeRequest(validQuoteData(), ownerAuth),
    );

    const result = await deleteQuoteHandler(
      fakeRequest({ quoteId }, ownerAuth),
    );
    expect(result.deleted).toBe(true);

    const snap = await testDb
      .doc(`tenants/${TENANT}/quotes/${quoteId}`)
      .get();
    expect(snap.exists).toBe(false);
  });

  it("rejects deletion of a converted quote", async () => {
    const { quoteId } = await createQuoteHandler(
      fakeRequest(validQuoteData(), ownerAuth),
    );
    await testDb
      .doc(`tenants/${TENANT}/quotes/${quoteId}`)
      .update({ status: "converted" });

    await expect(
      deleteQuoteHandler(fakeRequest({ quoteId }, ownerAuth)),
    ).rejects.toThrow(/Cannot delete a converted quote/);
  });

  it("rejects staff role (requires owner/admin)", async () => {
    const { quoteId } = await createQuoteHandler(
      fakeRequest(validQuoteData(), ownerAuth),
    );

    await expect(
      deleteQuoteHandler(fakeRequest({ quoteId }, staffAuth)),
    ).rejects.toThrow(/Requires one of/);
  });

  it("rejects when quote does not exist", async () => {
    await expect(
      deleteQuoteHandler(fakeRequest({ quoteId: "QT-9999" }, ownerAuth)),
    ).rejects.toThrow(/Quote not found/);
  });
});

// ---------------------------------------------------------------------------
// convertQuoteToInvoice
// ---------------------------------------------------------------------------

describe("convertQuoteToInvoice", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTenant();
  });

  it("happy path — creates invoice from quote, marks quote converted, back-references linked", async () => {
    const { quoteId } = await createQuoteHandler(
      fakeRequest(validQuoteData(), ownerAuth),
    );

    const result = await convertQuoteToInvoiceHandler(
      fakeRequest({ quoteId }, ownerAuth),
    );

    expect(result.invoiceId).toBe("INV-0001");
    expect(result.quoteId).toBe(quoteId);

    // Quote is marked converted with forward-reference
    const qt = (
      await testDb.doc(`tenants/${TENANT}/quotes/${quoteId}`).get()
    ).data()!;
    expect(qt.status).toBe("converted");
    expect(qt.convertedToInvoiceId).toBe("INV-0001");

    // Invoice exists with back-reference
    const inv = (
      await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).get()
    ).data()!;
    expect(inv.sourceQuoteId).toBe(quoteId);
    expect(inv.status).toBe("draft");

    // Invoice has same customer as quote
    expect(inv.customer.email).toBe("bob@example.com");
    expect(inv.customer.name).toBe("Bob Builder");

    // Invoice has same line items
    expect(inv.lineItems).toHaveLength(2);
    expect(inv.lineItems[0].description).toBe("Bathroom reno estimate");

    // Invoice has pay token
    expect(inv.payToken).toBeTruthy();
    expect(inv.payTokenVersion).toBe(1);
    const decoded = verify(inv.payToken, TEST_SECRET) as Record<
      string,
      unknown
    >;
    expect(decoded.invoiceId).toBe("INV-0001");
    expect(decoded.tenantId).toBe(TENANT);

    // Invoice counter incremented, quote counter unchanged
    const invCounter = (
      await testDb.doc(`tenants/${TENANT}/counters/invoice`).get()
    ).data()!;
    expect(invCounter.value).toBe(1);

    const qtCounter = (
      await testDb.doc(`tenants/${TENANT}/counters/quote`).get()
    ).data()!;
    expect(qtCounter.value).toBe(1);
  });

  it("uses fresh tenantSnapshot, not the quote's frozen snapshot", async () => {
    const { quoteId } = await createQuoteHandler(
      fakeRequest(validQuoteData(), ownerAuth),
    );

    // Change branding after quote creation
    await testDb.doc(`tenants/${TENANT}/meta/settings`).update({
      name: "Acme HVAC",
      taxRate: 0.15,
    });

    await convertQuoteToInvoiceHandler(
      fakeRequest({ quoteId }, ownerAuth),
    );

    // Quote still has old snapshot
    const qt = (
      await testDb.doc(`tenants/${TENANT}/quotes/${quoteId}`).get()
    ).data()!;
    expect(qt.tenantSnapshot.name).toBe("Acme Plumbing");

    // Invoice has FRESH snapshot with new branding
    const inv = (
      await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).get()
    ).data()!;
    expect(inv.tenantSnapshot.name).toBe("Acme HVAC");
    expect(inv.tenantSnapshot.taxRate).toBe(0.15);

    // Invoice totals use NEW tax rate
    // (1×5000 + 10×45) = 5450, 15% = 817.50
    expect(inv.totals.taxRate).toBe(0.15);
    expect(inv.totals.taxAmount).toBe(817.5);
    expect(inv.totals.total).toBe(6267.5);
  });

  it("rejects double-conversion", async () => {
    const { quoteId } = await createQuoteHandler(
      fakeRequest(validQuoteData(), ownerAuth),
    );

    await convertQuoteToInvoiceHandler(
      fakeRequest({ quoteId }, ownerAuth),
    );

    await expect(
      convertQuoteToInvoiceHandler(fakeRequest({ quoteId }, ownerAuth)),
    ).rejects.toThrow(/already been converted/);
  });

  it("rejects when quotes feature is disabled", async () => {
    const { quoteId } = await createQuoteHandler(
      fakeRequest(validQuoteData(), ownerAuth),
    );

    await testDb.doc(`tenants/${TENANT}/entitlements/current`).update({
      features: { quotes: false },
    });

    await expect(
      convertQuoteToInvoiceHandler(fakeRequest({ quoteId }, ownerAuth)),
    ).rejects.toThrow(/Feature 'quotes' is not enabled/);
  });

  it("rejects when quote does not exist", async () => {
    await expect(
      convertQuoteToInvoiceHandler(
        fakeRequest({ quoteId: "QT-9999" }, ownerAuth),
      ),
    ).rejects.toThrow(/Quote not found/);
  });
});
