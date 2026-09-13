import { beforeEach, describe, expect, it, vi } from "vitest";
import { verify } from "jsonwebtoken";

// ---------------------------------------------------------------------------
// Mock defineSecret — createInvoice uses PAY_TOKEN_SECRET via defineSecret.
// Must be mocked before the handler import.
// ---------------------------------------------------------------------------
const TEST_SECRET = "test-pay-token-secret-256bit-min!!";

vi.mock("firebase-functions/params", () => ({
  defineSecret: () => ({ value: () => TEST_SECRET }),
}));

// Mock logger to suppress noise during tests.
vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import {
  clearFirestore,
  fakeRequest,
  testDb,
} from "./_setup";

import { createInvoiceHandler } from "../../src/invoices/createInvoice";
import { updateInvoiceHandler } from "../../src/invoices/updateInvoice";
import { deleteInvoiceHandler } from "../../src/invoices/deleteInvoice";
import { markInvoicePaidHandler } from "../../src/invoices/markInvoicePaid";
import { FieldValue } from "firebase-admin/firestore";

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

function validInvoiceData(overrides: Record<string, unknown> = {}) {
  return {
    customer: { name: "Jane Doe", email: "Jane@Example.COM", phone: "555-1234" },
    lineItems: [
      { description: "Kitchen faucet install", quantity: 2, rate: 150 },
      { description: "Service call", quantity: 1, rate: 85 },
    ],
    applyTax: true,
    dueDate: "2026-05-15",
    notes: "Net 30",
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
  batch.set(testDb.doc(`tenants/${TENANT}/counters/invoice`), {
    value: 0,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createInvoice", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTenant();
  });

  it("happy path — creates invoice with correct ID, counter, snapshot, totals, and pay token", async () => {
    const result = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );

    expect(result.invoiceId).toBe("INV-0001");

    // Counter incremented
    const counter = await testDb
      .doc(`tenants/${TENANT}/counters/invoice`)
      .get();
    expect(counter.data()?.value).toBe(1);

    // Invoice doc
    const inv = await testDb
      .doc(`tenants/${TENANT}/invoices/INV-0001`)
      .get();
    expect(inv.exists).toBe(true);
    const data = inv.data()!;

    // Customer email lowercased (C2 fix)
    expect(data.customer.email).toBe("jane@example.com");
    expect(data.customer.name).toBe("Jane Doe");
    expect(data.customer.phone).toBe("555-1234");

    // Status
    expect(data.status).toBe("draft");

    // Server-computed totals: (2×150 + 1×85) = 385 subtotal, 13% tax = 50.05
    expect(data.totals.subtotal).toBe(385);
    expect(data.totals.taxRate).toBe(0.13);
    expect(data.totals.taxAmount).toBe(50.05);
    expect(data.totals.total).toBe(435.05);

    // D4 — per-tax breakdown recorded alongside the aggregate.
    expect(data.totals.taxableSubtotal).toBe(385);
    expect(data.totals.taxes).toEqual([
      { name: "HST", rate: 0.13, taxableAmount: 385, amount: 50.05 },
    ]);

    // Line items have server-computed amounts
    expect(data.lineItems).toHaveLength(2);
    expect(data.lineItems[0].amount).toBe(300);
    expect(data.lineItems[1].amount).toBe(85);
    // Lines without a flag inherit applyTax (D4).
    expect(data.lineItems[0].taxable).toBe(true);
    expect(data.lineItems[1].taxable).toBe(true);

    // Frozen tenantSnapshot
    expect(data.tenantSnapshot.version).toBe(1);
    expect(data.tenantSnapshot.name).toBe("Acme Plumbing");
    expect(data.tenantSnapshot.taxRate).toBe(0.13);
    expect(data.tenantSnapshot.currency).toBe("CAD");
    expect(data.tenantSnapshot.etransferEmail).toBe("pay@acme.test");
    expect(data.tenantSnapshot.chargeCustomerCardFees).toBe(false);
    expect(data.tenantSnapshot.cardFeePercent).toBe(2.4);
    // Logo is null because meta.logoUrl is null
    expect(data.tenantSnapshot.logo).toBeNull();

    // Pay token is a valid JWT
    expect(data.payToken).toBeTruthy();
    expect(data.payTokenVersion).toBe(1);
    const decoded = verify(data.payToken, TEST_SECRET) as Record<string, unknown>;
    expect(decoded.invoiceId).toBe("INV-0001");
    expect(decoded.tenantId).toBe(TENANT);
    expect(decoded.v).toBe(1);

    // createdBy
    expect(data.createdBy).toBe(OWNER_UID);
  });

  it("atomic counter — sequential creates produce INV-0001, INV-0002, INV-0003", async () => {
    const r1 = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );
    const r2 = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );
    const r3 = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );

    expect(r1.invoiceId).toBe("INV-0001");
    expect(r2.invoiceId).toBe("INV-0002");
    expect(r3.invoiceId).toBe("INV-0003");

    const counter = await testDb
      .doc(`tenants/${TENANT}/counters/invoice`)
      .get();
    expect(counter.data()?.value).toBe(3);
  });

  it("frozen snapshot preserves branding at creation time", async () => {
    // Create invoice with current branding
    await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );

    // Now change the tenant's branding
    await testDb.doc(`tenants/${TENANT}/meta/settings`).update({
      name: "Acme HVAC",
      primaryColor: "#ff0000",
      taxRate: 0.15,
    });

    // Create a second invoice — should have the NEW branding
    await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );

    // First invoice still has old branding
    const inv1 = (
      await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).get()
    ).data()!;
    expect(inv1.tenantSnapshot.name).toBe("Acme Plumbing");
    expect(inv1.tenantSnapshot.primaryColor).toBe("#667eea");
    expect(inv1.tenantSnapshot.taxRate).toBe(0.13);

    // Second invoice has new branding
    const inv2 = (
      await testDb.doc(`tenants/${TENANT}/invoices/INV-0002`).get()
    ).data()!;
    expect(inv2.tenantSnapshot.name).toBe("Acme HVAC");
    expect(inv2.tenantSnapshot.primaryColor).toBe("#ff0000");
    expect(inv2.tenantSnapshot.taxRate).toBe(0.15);

    // Second invoice totals use the NEW tax rate
    expect(inv2.totals.taxRate).toBe(0.15);
    expect(inv2.totals.taxAmount).toBe(57.75); // 385 * 0.15
  });

  it("computes totals with tax disabled", async () => {
    const result = await createInvoiceHandler(
      fakeRequest(validInvoiceData({ applyTax: false }), ownerAuth),
    );

    const inv = (
      await testDb
        .doc(`tenants/${TENANT}/invoices/${result.invoiceId}`)
        .get()
    ).data()!;
    expect(inv.totals.taxRate).toBe(0);
    expect(inv.totals.taxAmount).toBe(0);
    expect(inv.totals.taxes).toEqual([]);
    expect(inv.totals.total).toBe(385);
  });

  it("per-line taxable: exempt lines stay out of the tax base (D4)", async () => {
    const result = await createInvoiceHandler(
      fakeRequest(
        validInvoiceData({
          lineItems: [
            { description: "Cleaning", quantity: 1, rate: 200 },
            { description: "Exam (HST-exempt)", quantity: 1, rate: 100, taxable: false },
          ],
        }),
        ownerAuth,
      ),
    );
    const inv = (
      await testDb.doc(`tenants/${TENANT}/invoices/${result.invoiceId}`).get()
    ).data()!;
    expect(inv.lineItems[0].taxable).toBe(true);
    expect(inv.lineItems[1].taxable).toBe(false);
    expect(inv.totals).toEqual({
      subtotal: 300,
      taxableSubtotal: 200,
      taxRate: 0.13,
      taxAmount: 26,
      taxes: [{ name: "HST", rate: 0.13, taxableAmount: 200, amount: 26 }],
      total: 326,
    });
  });

  it("per-line taxable can opt a single line into tax when the invoice default is off (D4)", async () => {
    const result = await createInvoiceHandler(
      fakeRequest(
        validInvoiceData({
          applyTax: false,
          lineItems: [
            { description: "Parts", quantity: 1, rate: 100, taxable: true },
            { description: "Exempt labour", quantity: 1, rate: 50 },
          ],
        }),
        ownerAuth,
      ),
    );
    const inv = (
      await testDb.doc(`tenants/${TENANT}/invoices/${result.invoiceId}`).get()
    ).data()!;
    expect(inv.totals.taxableSubtotal).toBe(100);
    expect(inv.totals.taxAmount).toBe(13);
    expect(inv.totals.total).toBe(163);
  });

  it("rejects a non-boolean taxable flag (D4)", async () => {
    await expect(
      createInvoiceHandler(
        fakeRequest(
          validInvoiceData({
            lineItems: [{ description: "X", quantity: 1, rate: 1, taxable: "yes" }],
          }),
          ownerAuth,
        ),
      ),
    ).rejects.toThrow(/taxable must be a boolean/);
  });

  it("snapshot never enables surcharging while the cardSurcharge feature is off (D3)", async () => {
    await testDb.doc(`tenants/${TENANT}/meta/settings`).update({
      chargeCustomerCardFees: true,
    });

    const off = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );
    const offInv = (
      await testDb.doc(`tenants/${TENANT}/invoices/${off.invoiceId}`).get()
    ).data()!;
    expect(offInv.tenantSnapshot.chargeCustomerCardFees).toBe(false);

    await testDb.doc(`tenants/${TENANT}/entitlements/current`).update({
      features: { cardSurcharge: true },
    });
    const on = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );
    const onInv = (
      await testDb.doc(`tenants/${TENANT}/invoices/${on.invoiceId}`).get()
    ).data()!;
    expect(onInv.tenantSnapshot.chargeCustomerCardFees).toBe(true);
  });

  it("rejects unauthenticated caller", async () => {
    await expect(
      createInvoiceHandler(fakeRequest(validInvoiceData(), null)),
    ).rejects.toThrow(/Sign in required/);
  });

  it("rejects caller without tenantId claim", async () => {
    await expect(
      createInvoiceHandler(
        fakeRequest(validInvoiceData(), {
          uid: "u_rando",
          claims: { email: "rando@x.test" },
        }),
      ),
    ).rejects.toThrow(/Tenant membership required/);
  });

  it("rejects empty line items", async () => {
    await expect(
      createInvoiceHandler(
        fakeRequest(validInvoiceData({ lineItems: [] }), ownerAuth),
      ),
    ).rejects.toThrow(/At least one line item/);
  });

  it("rejects missing dueDate", async () => {
    await expect(
      createInvoiceHandler(
        fakeRequest(validInvoiceData({ dueDate: "" }), ownerAuth),
      ),
    ).rejects.toThrow(/dueDate required/);
  });
});

describe("updateInvoice", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTenant();
  });

  it("updates mutable fields and recomputes totals from frozen snapshot", async () => {
    // Create an invoice first
    const { invoiceId } = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );

    // Now change the tenant's tax rate in meta
    await testDb.doc(`tenants/${TENANT}/meta/settings`).update({
      taxRate: 0.20,
    });

    // Update invoice — totals must use the FROZEN snapshot taxRate (0.13), not 0.20
    await updateInvoiceHandler(
      fakeRequest(
        {
          invoiceId,
          customer: { name: "Jane Updated", email: "JANE@NEW.COM" },
          lineItems: [{ description: "Big job", quantity: 1, rate: 1000 }],
          applyTax: true,
          dueDate: "2026-06-01",
        },
        ownerAuth,
      ),
    );

    const inv = (
      await testDb.doc(`tenants/${TENANT}/invoices/${invoiceId}`).get()
    ).data()!;

    // Customer email lowercased
    expect(inv.customer.email).toBe("jane@new.com");
    expect(inv.customer.name).toBe("Jane Updated");

    // Totals use frozen snapshot taxRate (0.13), NOT current meta (0.20)
    expect(inv.totals.subtotal).toBe(1000);
    expect(inv.totals.taxRate).toBe(0.13);
    expect(inv.totals.taxAmount).toBe(130);
    expect(inv.totals.total).toBe(1130);

    // tenantSnapshot NOT changed
    expect(inv.tenantSnapshot.name).toBe("Acme Plumbing");
  });

  // A-08 — the emailed pay link must stop working when what it charges changes.

  async function sentInvoice(): Promise<{
    invoiceId: string;
    ref: FirebaseFirestore.DocumentReference;
    before: FirebaseFirestore.DocumentData;
  }> {
    const { invoiceId } = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );
    const ref = testDb.doc(`tenants/${TENANT}/invoices/${invoiceId}`);
    await ref.update({ status: "sent" });
    return { invoiceId, ref, before: (await ref.get()).data()! };
  }

  it("A-08: changing a sent invoice's total re-issues its pay link", async () => {
    const { invoiceId, ref, before } = await sentInvoice();

    const result = await updateInvoiceHandler(
      fakeRequest(
        {
          ...validInvoiceData({
            lineItems: [{ description: "Bigger job", quantity: 1, rate: 999 }],
          }),
          invoiceId,
        },
        ownerAuth,
      ),
    );

    expect(result.payLinkRegenerated).toBe(true);
    const after = (await ref.get()).data()!;
    expect(after.payTokenVersion).toBe(before.payTokenVersion + 1);
    expect(after.payToken).not.toBe(before.payToken);
    expect(verify(after.payToken, TEST_SECRET)).toMatchObject({
      invoiceId,
      tenantId: TENANT,
      v: before.payTokenVersion + 1,
    });
  });

  it("A-08: changing a sent invoice's customer email re-issues its pay link", async () => {
    const { invoiceId, ref, before } = await sentInvoice();

    const result = await updateInvoiceHandler(
      fakeRequest(
        {
          ...validInvoiceData({
            customer: { name: "Jane Doe", email: "someone.else@example.com" },
          }),
          invoiceId,
        },
        ownerAuth,
      ),
    );

    expect(result.payLinkRegenerated).toBe(true);
    expect((await ref.get()).data()!.payTokenVersion).toBe(
      before.payTokenVersion + 1,
    );
  });

  it("keeps the pay link when a sent invoice's edit changes neither amount nor recipient", async () => {
    const { invoiceId, ref, before } = await sentInvoice();

    const result = await updateInvoiceHandler(
      fakeRequest(
        {
          // Same line items and email (different letter case) — new notes and date.
          ...validInvoiceData({ notes: "Thanks!", dueDate: "2026-06-30" }),
          invoiceId,
        },
        ownerAuth,
      ),
    );

    expect(result.payLinkRegenerated).toBe(false);
    const after = (await ref.get()).data()!;
    expect(after.notes).toBe("Thanks!");
    expect(after.payTokenVersion).toBe(before.payTokenVersion);
    expect(after.payToken).toBe(before.payToken);
  });

  it("never re-issues the pay link while the invoice is a draft", async () => {
    const { invoiceId } = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );
    const ref = testDb.doc(`tenants/${TENANT}/invoices/${invoiceId}`);
    await ref.update({ status: "draft" });
    const before = (await ref.get()).data()!;

    const result = await updateInvoiceHandler(
      fakeRequest(
        {
          ...validInvoiceData({
            lineItems: [{ description: "Changed", quantity: 3, rate: 10 }],
          }),
          invoiceId,
        },
        ownerAuth,
      ),
    );

    expect(result.payLinkRegenerated).toBe(false);
    expect((await ref.get()).data()!.payTokenVersion).toBe(
      before.payTokenVersion,
    );
  });

  it("rejects update on a paid invoice", async () => {
    const { invoiceId } = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );

    // Manually set status to paid
    await testDb
      .doc(`tenants/${TENANT}/invoices/${invoiceId}`)
      .update({ status: "paid" });

    await expect(
      updateInvoiceHandler(
        fakeRequest(
          { ...validInvoiceData(), invoiceId },
          ownerAuth,
        ),
      ),
    ).rejects.toThrow(/Cannot update an invoice with status 'paid'/);
  });

  it("rejects when invoice does not exist", async () => {
    await expect(
      updateInvoiceHandler(
        fakeRequest(
          { ...validInvoiceData(), invoiceId: "INV-9999" },
          ownerAuth,
        ),
      ),
    ).rejects.toThrow(/Invoice not found/);
  });
});

describe("deleteInvoice", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTenant();
  });

  it("owner can delete a draft invoice", async () => {
    const { invoiceId } = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );

    const result = await deleteInvoiceHandler(
      fakeRequest({ invoiceId }, ownerAuth),
    );
    expect(result.deleted).toBe(true);

    const snap = await testDb
      .doc(`tenants/${TENANT}/invoices/${invoiceId}`)
      .get();
    expect(snap.exists).toBe(false);
  });

  it.each(["sent", "unpaid", "overdue", "partial", "paid", "refunded", "void"])(
    "A-12: refuses to delete a %s invoice, which stays on record",
    async (status) => {
      const { invoiceId } = await createInvoiceHandler(
        fakeRequest(validInvoiceData(), ownerAuth),
      );
      const ref = testDb.doc(`tenants/${TENANT}/invoices/${invoiceId}`);
      await ref.update({ status });

      await expect(
        deleteInvoiceHandler(fakeRequest({ invoiceId }, ownerAuth)),
      ).rejects.toThrow(
        status === "void"
          ? /void and stays on record/
          : /Only drafts can be deleted\. Void this/,
      );
      expect((await ref.get()).exists).toBe(true);
    },
  );

  it("rejects staff role (requires owner/admin)", async () => {
    const { invoiceId } = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );

    await expect(
      deleteInvoiceHandler(fakeRequest({ invoiceId }, staffAuth)),
    ).rejects.toThrow(/Requires one of/);
  });

  it("rejects when invoice does not exist", async () => {
    await expect(
      deleteInvoiceHandler(
        fakeRequest({ invoiceId: "INV-9999" }, ownerAuth),
      ),
    ).rejects.toThrow(/Invoice not found/);
  });
});

describe("markInvoicePaid", () => {
  beforeEach(async () => {
    await clearFirestore();
    await seedTenant();
  });

  it("marks a sent invoice as paid with etransfer method", async () => {
    const { invoiceId } = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );
    // Move to 'sent' status so markInvoicePaid accepts it
    await testDb
      .doc(`tenants/${TENANT}/invoices/${invoiceId}`)
      .update({ status: "sent" });

    const result = await markInvoicePaidHandler(
      fakeRequest(
        { invoiceId, paymentMethod: "etransfer" },
        ownerAuth,
      ),
    );
    expect(result.status).toBe("paid");

    const inv = (
      await testDb.doc(`tenants/${TENANT}/invoices/${invoiceId}`).get()
    ).data()!;
    expect(inv.status).toBe("paid");
    expect(inv.paymentMethod).toBe("etransfer");
    expect(inv.paidAt).toBeTruthy();
  });

  it("defaults to 'manual' when no paymentMethod provided", async () => {
    const { invoiceId } = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );
    await testDb
      .doc(`tenants/${TENANT}/invoices/${invoiceId}`)
      .update({ status: "sent" });

    await markInvoicePaidHandler(
      fakeRequest({ invoiceId }, ownerAuth),
    );

    const inv = (
      await testDb.doc(`tenants/${TENANT}/invoices/${invoiceId}`).get()
    ).data()!;
    expect(inv.paymentMethod).toBe("manual");
  });

  it("rejects marking a draft invoice as paid", async () => {
    const { invoiceId } = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );

    await expect(
      markInvoicePaidHandler(fakeRequest({ invoiceId }, ownerAuth)),
    ).rejects.toThrow(/Cannot mark a draft invoice as paid/);
  });

  it("rejects double-pay", async () => {
    const { invoiceId } = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );
    await testDb
      .doc(`tenants/${TENANT}/invoices/${invoiceId}`)
      .update({ status: "sent" });

    await markInvoicePaidHandler(
      fakeRequest({ invoiceId }, ownerAuth),
    );

    await expect(
      markInvoicePaidHandler(fakeRequest({ invoiceId }, ownerAuth)),
    ).rejects.toThrow(/already marked as paid/);
  });

  it("rejects staff role (requires owner/admin)", async () => {
    const { invoiceId } = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );
    await testDb
      .doc(`tenants/${TENANT}/invoices/${invoiceId}`)
      .update({ status: "sent" });

    await expect(
      markInvoicePaidHandler(fakeRequest({ invoiceId }, staffAuth)),
    ).rejects.toThrow(/Requires one of/);
  });

  it("rejects invalid paymentMethod", async () => {
    const { invoiceId } = await createInvoiceHandler(
      fakeRequest(validInvoiceData(), ownerAuth),
    );
    await testDb
      .doc(`tenants/${TENANT}/invoices/${invoiceId}`)
      .update({ status: "sent" });

    await expect(
      markInvoicePaidHandler(
        fakeRequest({ invoiceId, paymentMethod: "bitcoin" }, ownerAuth),
      ),
    ).rejects.toThrow(/paymentMethod must be one of/);
  });
});
