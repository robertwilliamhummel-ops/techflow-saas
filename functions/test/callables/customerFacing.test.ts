import { beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "jsonwebtoken";

// ---------------------------------------------------------------------------
// Mocks — must be set before handler imports
// ---------------------------------------------------------------------------
const TEST_SECRET = "test-pay-token-secret-256bit-min!!";
const TEST_STRIPE_SECRET = "sk_test_fake";

vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({
    value: () => {
      if (name === "PAY_TOKEN_SECRET") return TEST_SECRET;
      if (name === "STRIPE_SECRET_KEY") return TEST_STRIPE_SECRET;
      if (name === "AWS_SES_ACCESS_KEY_ID") return "AKIA_TEST";
      return "mock-secret";
    },
  }),
}));

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Mock Amazon SES (D5) — sendInvoiceEmail and sendQuoteEmail send through it.
// SendEmailCommand is reduced to { input } so tests can inspect the request.
const mockSesSend = vi.fn().mockResolvedValue({ MessageId: "ses_msg_123" });
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: vi.fn().mockImplementation(() => ({ send: mockSesSend })),
  SendEmailCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ input })),
}));

// Mock Stripe — createPayTokenCheckoutSession uses it.
const mockStripeCreate = vi.fn().mockResolvedValue({
  id: "cs_test_123",
  url: "https://checkout.stripe.com/test",
});
vi.mock("stripe", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      checkout: {
        sessions: { create: mockStripeCreate },
      },
    })),
  };
});

// Mock @react-email/render to avoid JSX rendering in tests.
vi.mock("@react-email/render", () => ({
  render: vi.fn().mockResolvedValue("<html>mock</html>"),
}));

import {
  clearFirestore,
  fakeRequest,
  testDb,
} from "./_setup";

import {
  getCustomerInvoicesHandler,
  listCustomerInvoices,
} from "../../src/portal/getCustomerInvoices";
import { Timestamp } from "firebase-admin/firestore";
import { getCustomerInvoiceDetailHandler } from "../../src/portal/getCustomerInvoiceDetail";
import { verifyInvoicePayTokenHandler } from "../../src/portal/verifyInvoicePayToken";
import { createPayTokenCheckoutSessionHandler } from "../../src/portal/createPayTokenCheckoutSession";
import { regenerateInvoicePayLinkHandler } from "../../src/invoices/regenerateInvoicePayLink";
import { sendInvoiceEmailHandler } from "../../src/invoices/sendInvoiceEmail";
import { sendQuoteEmailHandler } from "../../src/quotes/sendQuoteEmail";
import { FieldValue } from "firebase-admin/firestore";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT = "acme-plumbing";
const OWNER_UID = "u_owner";
const CUSTOMER_EMAIL = "jane@example.com";

const ownerAuth = {
  uid: OWNER_UID,
  claims: {
    email: "owner@acme.test",
    tenantId: TENANT,
    role: "owner" as const,
  },
};

const customerAuth = {
  uid: "u_customer",
  claims: {
    email: CUSTOMER_EMAIL,
    email_verified: true,
  },
};

const wrongCustomerAuth = {
  uid: "u_wrong",
  claims: {
    email: "wrong@example.com",
    email_verified: true,
  },
};

function makePayToken(
  invoiceId: string,
  tenantId: string,
  version: number,
  expiresIn = "60d",
) {
  return sign(
    { invoiceId, tenantId, v: version },
    TEST_SECRET,
    { expiresIn },
  );
}

async function seedTenantAndInvoice(): Promise<string> {
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
    stripeAccountId: "acct_test_123",
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(testDb.doc(`tenants/${TENANT}/entitlements/current`), {
    plan: "starter",
    features: { stripePayments: true },
    updatedAt: FieldValue.serverTimestamp(),
  });

  const invoiceId = "INV-0001";
  const payToken = makePayToken(invoiceId, TENANT, 1);
  batch.set(testDb.doc(`tenants/${TENANT}/invoices/${invoiceId}`), {
    customer: { name: "Jane Doe", email: CUSTOMER_EMAIL, phone: null },
    lineItems: [
      { description: "Service call", quantity: 1, rate: 100, amount: 100 },
    ],
    applyTax: true,
    totals: { subtotal: 100, taxRate: 0.13, taxAmount: 13, total: 113 },
    tenantSnapshot: {
      version: 1,
      name: "Acme Plumbing",
      logo: null,
      address: "123 Main St",
      primaryColor: "#667eea",
      secondaryColor: "#764ba2",
      fontFamily: "Inter",
      faviconUrl: null,
      taxRate: 0.13,
      taxName: "HST",
      businessNumber: "123456789",
      emailFooter: null,
      currency: "CAD",
      chargeCustomerCardFees: false,
      cardFeePercent: 2.4,
      etransferEmail: "pay@acme.test",
    },
    status: "sent",
    dueDate: "2026-05-15",
    issueDate: "2026-04-15",
    notes: null,
    payToken,
    payTokenExpiresAt: FieldValue.serverTimestamp(),
    payTokenVersion: 1,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: OWNER_UID,
  });

  await batch.commit();
  return payToken;
}

async function seedQuote(): Promise<void> {
  const batch = testDb.batch();
  batch.set(testDb.doc(`tenants/${TENANT}/counters/quote`), {
    value: 1,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(testDb.doc(`tenants/${TENANT}/quotes/QT-0001`), {
    customer: { name: "Jane Doe", email: CUSTOMER_EMAIL, phone: null },
    lineItems: [
      { description: "Estimate", quantity: 1, rate: 200, amount: 200 },
    ],
    applyTax: true,
    totals: { subtotal: 200, taxRate: 0.13, taxAmount: 26, total: 226 },
    tenantSnapshot: {
      version: 1,
      name: "Acme Plumbing",
      logo: null,
      address: "123 Main St",
      primaryColor: "#667eea",
      secondaryColor: "#764ba2",
      fontFamily: "Inter",
      faviconUrl: null,
      taxRate: 0.13,
      taxName: "HST",
      businessNumber: "123456789",
      emailFooter: null,
      currency: "CAD",
      chargeCustomerCardFees: false,
      cardFeePercent: 2.4,
      etransferEmail: "pay@acme.test",
    },
    status: "draft",
    validUntil: "2026-05-30",
    issueDate: "2026-04-15",
    notes: null,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: OWNER_UID,
  });
  await batch.commit();
}

// ---------------------------------------------------------------------------
// getCustomerInvoices
// ---------------------------------------------------------------------------

describe("getCustomerInvoices", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTenantAndInvoice();
  });

  it("returns invoices for the verified customer email", async () => {
    const result = await getCustomerInvoicesHandler(
      fakeRequest({}, customerAuth),
    );
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0].id).toBe("INV-0001");
    expect(result.invoices[0].tenantBranding.name).toBe("Acme Plumbing");
    expect(result.invoices[0].totals.total).toBe(113);
  });

  it("returns empty for a customer with no invoices", async () => {
    const result = await getCustomerInvoicesHandler(
      fakeRequest({}, wrongCustomerAuth),
    );
    expect(result.invoices).toHaveLength(0);
  });

  // A-05 — drafts and inlined logos never reach the portal list.

  async function seedCustomerInvoice(
    id: string,
    status: string,
    createdAtMs: number,
  ): Promise<void> {
    await testDb.doc(`tenants/${TENANT}/invoices/${id}`).set({
      customer: { name: "Jane Doe", email: CUSTOMER_EMAIL, phone: null },
      totals: { subtotal: 10, taxAmount: 0, total: 10 },
      tenantSnapshot: { name: "Acme Plumbing", logo: null, primaryColor: "#123456" },
      status,
      dueDate: "2026-05-15",
      issueDate: "2026-04-15",
      createdAt: Timestamp.fromMillis(createdAtMs),
    });
  }

  it("A-05: never lists draft invoices", async () => {
    await seedCustomerInvoice("INV-0002", "draft", Date.now() + 60_000);

    const result = await getCustomerInvoicesHandler(
      fakeRequest({}, customerAuth),
    );

    expect(result.invoices.map((invoice) => invoice.id)).toEqual(["INV-0001"]);
  });

  it("A-05: rows carry the snapshot logo URL, never the inlined base64 logo", async () => {
    await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).update({
      "tenantSnapshot.logo": "data:image/png;base64,iVBORw0KGgo=",
      "tenantSnapshot.logoUrl": "https://storage.example.com/logo.png",
    });

    const result = await getCustomerInvoicesHandler(
      fakeRequest({}, customerAuth),
    );

    expect(result.invoices[0].tenantBranding).toEqual({
      name: "Acme Plumbing",
      logoUrl: "https://storage.example.com/logo.png",
      primaryColor: "#667eea",
    });
    expect(JSON.stringify(result)).not.toContain("base64");
  });

  it("A-05: keeps paging past drafts until the list is full", async () => {
    const now = Date.now();
    // Newest first: three drafts sit between the seeded invoice and two older
    // visible ones, so a single page of two would come back almost empty.
    await seedCustomerInvoice("INV-D1", "draft", now - 1_000);
    await seedCustomerInvoice("INV-D2", "draft", now - 2_000);
    await seedCustomerInvoice("INV-D3", "draft", now - 3_000);
    await seedCustomerInvoice("INV-S1", "paid", now - 4_000);
    await seedCustomerInvoice("INV-S2", "overdue", now - 5_000);
    await testDb
      .doc(`tenants/${TENANT}/invoices/INV-0001`)
      .update({ createdAt: Timestamp.fromMillis(now) });

    const items = await listCustomerInvoices(CUSTOMER_EMAIL, {
      limit: 3,
      pageSize: 2,
    });

    expect(items.map((item) => item.id)).toEqual(["INV-0001", "INV-S1", "INV-S2"]);
  });

  it("rejects unauthenticated caller", async () => {
    await expect(
      getCustomerInvoicesHandler(fakeRequest({}, null)),
    ).rejects.toThrow(/Sign in required/);
  });

  it("rejects caller without email_verified", async () => {
    await expect(
      getCustomerInvoicesHandler(
        fakeRequest(
          {},
          { uid: "u_unverified", claims: { email: "a@b.com" } },
        ),
      ),
    ).rejects.toThrow(/Verified email required/);
  });
});

// ---------------------------------------------------------------------------
// getCustomerInvoiceDetail
// ---------------------------------------------------------------------------

describe("getCustomerInvoiceDetail", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTenantAndInvoice();
  });

  it("returns invoice detail for the matching customer", async () => {
    const result = await getCustomerInvoiceDetailHandler(
      fakeRequest({ tenantId: TENANT, invoiceId: "INV-0001" }, customerAuth),
    );
    expect(result.id).toBe("INV-0001");
    expect(result.tenantId).toBe(TENANT);
    // payToken should be stripped
    expect(result).not.toHaveProperty("payToken");
  });

  it("rejects customer whose email does not match", async () => {
    await expect(
      getCustomerInvoiceDetailHandler(
        fakeRequest(
          { tenantId: TENANT, invoiceId: "INV-0001" },
          wrongCustomerAuth,
        ),
      ),
    ).rejects.toThrow(/Not your invoice/);
  });

  it("rejects missing invoiceId", async () => {
    await expect(
      getCustomerInvoiceDetailHandler(
        fakeRequest({ tenantId: TENANT }, customerAuth),
      ),
    ).rejects.toThrow(/invoiceId required/);
  });

  it("returns not-found for non-existent invoice", async () => {
    await expect(
      getCustomerInvoiceDetailHandler(
        fakeRequest(
          { tenantId: TENANT, invoiceId: "INV-9999" },
          customerAuth,
        ),
      ),
    ).rejects.toThrow(/Invoice not found/);
  });

  it("A-05: a draft invoice is not found, even for the matching customer", async () => {
    await testDb
      .doc(`tenants/${TENANT}/invoices/INV-0001`)
      .update({ status: "draft" });

    await expect(
      getCustomerInvoiceDetailHandler(
        fakeRequest({ tenantId: TENANT, invoiceId: "INV-0001" }, customerAuth),
      ),
    ).rejects.toThrow(/Invoice not found/);
  });
});

// ---------------------------------------------------------------------------
// verifyInvoicePayToken
// ---------------------------------------------------------------------------

describe("verifyInvoicePayToken", () => {
  let validToken: string;

  beforeEach(async () => {
    await clearFirestore();
    validToken = await seedTenantAndInvoice();
  });

  it("returns ok for a valid payable token", async () => {
    // No auth required for this callable
    const result = await verifyInvoicePayTokenHandler(
      fakeRequest({ token: validToken }, null),
    );
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") {
      expect(result.invoice.invoiceId).toBe("INV-0001");
      expect(result.invoice.totals.total).toBe(113);
    }
  });

  it("reports no surcharge while the cardSurcharge feature is off, even if the snapshot says so (D3)", async () => {
    await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).update({
      "tenantSnapshot.chargeCustomerCardFees": true,
    });
    const off = await verifyInvoicePayTokenHandler(
      fakeRequest({ token: validToken }, null),
    );
    expect(off.outcome).toBe("ok");
    if (off.outcome === "ok") {
      expect(off.invoice.chargeCustomerCardFees).toBe(false);
      expect(off.invoice.cardFeePercent).toBe(0);
    }

    await testDb.doc(`tenants/${TENANT}/entitlements/current`).update({
      features: { stripePayments: true, cardSurcharge: true },
    });
    const on = await verifyInvoicePayTokenHandler(
      fakeRequest({ token: validToken }, null),
    );
    if (on.outcome === "ok") {
      expect(on.invoice.chargeCustomerCardFees).toBe(true);
      expect(on.invoice.cardFeePercent).toBe(2.4);
    }
  });

  it("returns paid for already-paid invoices", async () => {
    await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).update({
      status: "paid",
      paidAt: FieldValue.serverTimestamp(),
    });
    const result = await verifyInvoicePayTokenHandler(
      fakeRequest({ token: validToken }, null),
    );
    expect(result.outcome).toBe("paid");
  });

  it("returns regenerated when payTokenVersion mismatches", async () => {
    await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).update({
      payTokenVersion: 2,
    });
    const result = await verifyInvoicePayTokenHandler(
      fakeRequest({ token: validToken }, null),
    );
    expect(result.outcome).toBe("regenerated");
  });

  it("returns not-available for draft invoices", async () => {
    await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).update({
      status: "draft",
    });
    const result = await verifyInvoicePayTokenHandler(
      fakeRequest({ token: validToken }, null),
    );
    expect(result.outcome).toBe("not-available");
  });

  it("returns refunded for refunded invoices", async () => {
    await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).update({
      status: "refunded",
      refundedAt: FieldValue.serverTimestamp(),
    });
    const result = await verifyInvoicePayTokenHandler(
      fakeRequest({ token: validToken }, null),
    );
    expect(result.outcome).toBe("refunded");
  });

  it("A-12: returns void for a voided invoice, even through an older link", async () => {
    await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).update({
      status: "void",
      payTokenVersion: 2,
    });
    const result = await verifyInvoicePayTokenHandler(
      fakeRequest({ token: validToken }, null),
    );
    expect(result).toEqual({ outcome: "void", invoiceNumber: "INV-0001" });
  });

  it("throws on invalid token", async () => {
    await expect(
      verifyInvoicePayTokenHandler(
        fakeRequest({ token: "bad-token" }, null),
      ),
    ).rejects.toThrow(/Invalid or expired pay link/);
  });

  it("throws on expired token", async () => {
    const expired = sign(
      { invoiceId: "INV-0001", tenantId: TENANT, v: 1 },
      TEST_SECRET,
      { expiresIn: "0s" },
    );
    // Small delay to ensure it's expired
    await new Promise((r) => setTimeout(r, 50));
    await expect(
      verifyInvoicePayTokenHandler(
        fakeRequest({ token: expired }, null),
      ),
    ).rejects.toThrow(/Invalid or expired pay link/);
  });

  it("throws on missing token", async () => {
    await expect(
      verifyInvoicePayTokenHandler(fakeRequest({}, null)),
    ).rejects.toThrow(/Token required/);
  });
});

// ---------------------------------------------------------------------------
// createPayTokenCheckoutSession
// ---------------------------------------------------------------------------

describe("createPayTokenCheckoutSession", () => {
  let validToken: string;

  beforeEach(async () => {
    await clearFirestore();
    validToken = await seedTenantAndInvoice();
    mockStripeCreate.mockClear();
    mockStripeCreate.mockResolvedValue({
      id: "cs_test_123",
      url: "https://checkout.stripe.com/test",
    });
  });

  it("creates a Stripe session and returns url", async () => {
    const result = await createPayTokenCheckoutSessionHandler(
      fakeRequest({ token: validToken }, null),
    );
    expect(result.url).toBe("https://checkout.stripe.com/test");
    expect(mockStripeCreate).toHaveBeenCalledOnce();

    // Verify metadata was stamped with payTokenVersion
    const createArgs = mockStripeCreate.mock.calls[0][0];
    expect(createArgs.metadata.payTokenVersion).toBe("1");
    expect(createArgs.metadata.tenantId).toBe(TENANT);

    // The payment itself names the invoice in the contractor's Stripe Dashboard.
    expect(createArgs.payment_intent_data).toEqual({
      description: "Invoice INV-0001",
      metadata: { invoiceId: "INV-0001", tenantId: TENANT },
    });
  });

  it("rejects already-paid invoices", async () => {
    await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).update({
      status: "paid",
    });
    await expect(
      createPayTokenCheckoutSessionHandler(
        fakeRequest({ token: validToken }, null),
      ),
    ).rejects.toThrow(/already paid/);
  });

  it("rejects version mismatch", async () => {
    await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).update({
      payTokenVersion: 2,
    });
    await expect(
      createPayTokenCheckoutSessionHandler(
        fakeRequest({ token: validToken }, null),
      ),
    ).rejects.toThrow(/invalidated/);
  });

  it("rejects draft invoices", async () => {
    await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).update({
      status: "draft",
    });
    await expect(
      createPayTokenCheckoutSessionHandler(
        fakeRequest({ token: validToken }, null),
      ),
    ).rejects.toThrow(/not available for payment/);
  });

  it("rejects when stripeStatus.chargesEnabled is false (preflight)", async () => {
    await testDb.doc(`tenants/${TENANT}/meta/settings`).update({
      stripeStatus: { chargesEnabled: false },
    });
    await expect(
      createPayTokenCheckoutSessionHandler(
        fakeRequest({ token: validToken }, null),
      ),
    ).rejects.toThrow(/cannot accept card payments/);
    expect(mockStripeCreate).not.toHaveBeenCalled();
  });

  it("adds the surcharge line item from the invoice snapshot when cardSurcharge is enabled", async () => {
    await testDb.doc(`tenants/${TENANT}/entitlements/current`).update({
      features: { stripePayments: true, cardSurcharge: true },
    });
    await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).update({
      "tenantSnapshot.chargeCustomerCardFees": true,
    });

    await createPayTokenCheckoutSessionHandler(
      fakeRequest({ token: validToken }, null),
    );
    const args = mockStripeCreate.mock.calls[0][0];
    expect(args.line_items).toHaveLength(2);
    expect(args.line_items[1].price_data.unit_amount).toBe(271); // 2.4% of $113.00
    expect(args.metadata.surchargeCents).toBe("271");
  });

  it("never surcharges while cardSurcharge is off, even if the snapshot says so (D3)", async () => {
    await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).update({
      "tenantSnapshot.chargeCustomerCardFees": true,
    });

    await createPayTokenCheckoutSessionHandler(
      fakeRequest({ token: validToken }, null),
    );
    const args = mockStripeCreate.mock.calls[0][0];
    expect(args.line_items).toHaveLength(1);
    expect(args.metadata.surchargeCents).toBe("0");
  });

  it("charges what the snapshot disclosed, not current payment settings (A-09)", async () => {
    await testDb.doc(`tenants/${TENANT}/entitlements/current`).update({
      features: { stripePayments: true, cardSurcharge: true },
    });
    // Tenant turns surcharging on AFTER the invoice was sent without it.
    await testDb.doc(`tenants/${TENANT}/meta/settings`).update({
      chargeCustomerCardFees: true,
    });

    await createPayTokenCheckoutSessionHandler(
      fakeRequest({ token: validToken }, null),
    );
    const args = mockStripeCreate.mock.calls[0][0];
    expect(args.line_items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// regenerateInvoicePayLink
// ---------------------------------------------------------------------------

describe("regenerateInvoicePayLink", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTenantAndInvoice();
  });

  it("increments payTokenVersion and returns new token", async () => {
    const result = await regenerateInvoicePayLinkHandler(
      fakeRequest({ invoiceId: "INV-0001" }, ownerAuth),
    );
    expect(result.payToken).toBeDefined();
    expect(typeof result.payToken).toBe("string");
    expect(result.payTokenExpiresAt).toBeGreaterThan(Date.now());

    // Verify Firestore was updated
    const inv = await testDb
      .doc(`tenants/${TENANT}/invoices/INV-0001`)
      .get();
    expect(inv.data()?.payTokenVersion).toBe(2);
  });

  it("rejects staff (non-owner/admin)", async () => {
    await expect(
      regenerateInvoicePayLinkHandler(
        fakeRequest({ invoiceId: "INV-0001" }, {
          uid: "u_staff",
          claims: {
            email: "staff@acme.test",
            tenantId: TENANT,
            role: "staff" as const,
          },
        }),
      ),
    ).rejects.toThrow(/Requires one of/);
  });

  it("rejects missing invoiceId", async () => {
    await expect(
      regenerateInvoicePayLinkHandler(fakeRequest({}, ownerAuth)),
    ).rejects.toThrow(/invoiceId required/);
  });
});

// ---------------------------------------------------------------------------
// sendInvoiceEmail
// ---------------------------------------------------------------------------

describe("sendInvoiceEmail", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTenantAndInvoice();
    mockSesSend.mockClear();
    mockSesSend.mockResolvedValue({ MessageId: "ses_msg_456" });
  });

  it("sends email and transitions draft to sent", async () => {
    // Set invoice to draft first
    await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).update({
      status: "draft",
    });

    const result = await sendInvoiceEmailHandler(
      fakeRequest({ invoiceId: "INV-0001" }, ownerAuth),
    );
    expect(result.success).toBe(true);
    expect(mockSesSend).toHaveBeenCalledOnce();

    // Verify status transitioned
    const inv = await testDb
      .doc(`tenants/${TENANT}/invoices/INV-0001`)
      .get();
    expect(inv.data()?.status).toBe("sent");
  });

  it("sends email without changing status if already sent", async () => {
    const result = await sendInvoiceEmailHandler(
      fakeRequest({ invoiceId: "INV-0001" }, ownerAuth),
    );
    expect(result.success).toBe(true);

    const inv = await testDb
      .doc(`tenants/${TENANT}/invoices/INV-0001`)
      .get();
    expect(inv.data()?.status).toBe("sent"); // unchanged
  });

  it("rejects unauthenticated", async () => {
    await expect(
      sendInvoiceEmailHandler(
        fakeRequest({ invoiceId: "INV-0001" }, null),
      ),
    ).rejects.toThrow(/Sign in required/);
  });

  it("rejects non-existent invoice", async () => {
    await expect(
      sendInvoiceEmailHandler(
        fakeRequest({ invoiceId: "INV-9999" }, ownerAuth),
      ),
    ).rejects.toThrow(/Invoice not found/);
  });

  it("S-04: refuses to email an invoice with nothing left to pay", async () => {
    for (const status of ["paid", "refunded", "partially-refunded"]) {
      await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).update({ status });
      await expect(
        sendInvoiceEmailHandler(fakeRequest({ invoiceId: "INV-0001" }, ownerAuth)),
      ).rejects.toThrow(/nothing left to pay/);
    }
    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it("rejects when neither card nor e-transfer rail is ready (preflight)", async () => {
    await testDb.doc(`tenants/${TENANT}/meta/settings`).update({
      etransferEmail: FieldValue.delete(),
    });
    await expect(
      sendInvoiceEmailHandler(
        fakeRequest({ invoiceId: "INV-0001" }, ownerAuth),
      ),
    ).rejects.toThrow(/Add an e-transfer email or finish Stripe onboarding/);
    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it("sends when only card rail is ready (chargesEnabled true)", async () => {
    await testDb.doc(`tenants/${TENANT}/meta/settings`).update({
      etransferEmail: FieldValue.delete(),
      stripeStatus: { chargesEnabled: true },
    });
    const result = await sendInvoiceEmailHandler(
      fakeRequest({ invoiceId: "INV-0001" }, ownerAuth),
    );
    expect(result.success).toBe(true);
    expect(mockSesSend).toHaveBeenCalledOnce();
  });

  it("sends when only e-transfer rail is ready (no Stripe)", async () => {
    await testDb.doc(`tenants/${TENANT}/meta/settings`).update({
      stripeStatus: { chargesEnabled: false },
    });
    const result = await sendInvoiceEmailHandler(
      fakeRequest({ invoiceId: "INV-0001" }, ownerAuth),
    );
    expect(result.success).toBe(true);
    expect(mockSesSend).toHaveBeenCalledOnce();
  });
});

describe("sendInvoiceEmail — SES request shape (D5)", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTenantAndInvoice();
    mockSesSend.mockClear();
    mockSesSend.mockResolvedValue({ MessageId: "ses_msg_shape" });
  });

  it("sends as the tenant with Reply-To contactEmail and bounce-tracking tags", async () => {
    await testDb.doc(`tenants/${TENANT}/meta/settings`).update({
      contactEmail: "office@acme.test",
    });

    await sendInvoiceEmailHandler(
      fakeRequest({ invoiceId: "INV-0001" }, ownerAuth),
    );

    const input = mockSesSend.mock.calls[0][0].input;
    expect(input.Destination.ToAddresses).toEqual([CUSTOMER_EMAIL]);
    expect(input.FromEmailAddress).toBe(
      '"Acme Plumbing" <notifications@techflowsolutions.ca>',
    );
    expect(input.ReplyToAddresses).toEqual(["office@acme.test"]);
    expect(input.Content.Simple.Subject.Data).toContain("INV-0001");
    expect(input.EmailTags).toEqual(
      expect.arrayContaining([
        { Name: "category", Value: "invoice" },
        { Name: "tenantId", Value: TENANT },
        { Name: "documentId", Value: "INV-0001" },
      ]),
    );
  });

  it("falls back to the e-transfer email for Reply-To when no contactEmail is set", async () => {
    await sendInvoiceEmailHandler(
      fakeRequest({ invoiceId: "INV-0001" }, ownerAuth),
    );
    const input = mockSesSend.mock.calls[0][0].input;
    expect(input.ReplyToAddresses).toEqual(["pay@acme.test"]);
  });

  it("does not deduplicate manual resends", async () => {
    await sendInvoiceEmailHandler(
      fakeRequest({ invoiceId: "INV-0001" }, ownerAuth),
    );
    await sendInvoiceEmailHandler(
      fakeRequest({ invoiceId: "INV-0001" }, ownerAuth),
    );
    expect(mockSesSend).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// sendQuoteEmail
// ---------------------------------------------------------------------------

describe("sendQuoteEmail", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTenantAndInvoice(); // seeds tenant meta + entitlements
    await seedQuote();
    mockSesSend.mockClear();
    mockSesSend.mockResolvedValue({ MessageId: "ses_msg_789" });
  });

  it("sends email and transitions draft to sent", async () => {
    const result = await sendQuoteEmailHandler(
      fakeRequest({ quoteId: "QT-0001" }, ownerAuth),
    );
    expect(result.success).toBe(true);
    expect(mockSesSend).toHaveBeenCalledOnce();

    const qt = await testDb
      .doc(`tenants/${TENANT}/quotes/QT-0001`)
      .get();
    expect(qt.data()?.status).toBe("sent");
  });

  it("rejects non-existent quote", async () => {
    await expect(
      sendQuoteEmailHandler(
        fakeRequest({ quoteId: "QT-9999" }, ownerAuth),
      ),
    ).rejects.toThrow(/Quote not found/);
  });

  it("S-06: refuses to email a quote that was converted to an invoice", async () => {
    await testDb.doc(`tenants/${TENANT}/quotes/QT-0001`).update({
      status: "converted",
      convertedToInvoiceId: "INV-0001",
    });
    await expect(
      sendQuoteEmailHandler(fakeRequest({ quoteId: "QT-0001" }, ownerAuth)),
    ).rejects.toThrow(/converted to an invoice/);
    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated", async () => {
    await expect(
      sendQuoteEmailHandler(
        fakeRequest({ quoteId: "QT-0001" }, null),
      ),
    ).rejects.toThrow(/Sign in required/);
  });
});
