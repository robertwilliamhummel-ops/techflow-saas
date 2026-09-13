// A-12 — issued invoices are voided, not deleted, and a void invoice is final:
// it can't be paid, edited, sent, or given a new pay link.

import { beforeEach, describe, expect, it, vi } from "vitest";

const TEST_SECRET = "test-pay-token-secret-256bit-min!!";

vi.mock("firebase-functions/params", () => ({
  defineSecret: () => ({ value: () => TEST_SECRET }),
}));

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Amazon SES (D5) — SendEmailCommand reduced to { input } for inspection.
const mockSesSend = vi.fn().mockResolvedValue({ MessageId: "ses_msg_123" });
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: vi.fn().mockImplementation(() => ({ send: mockSesSend })),
  SendEmailCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ input })),
}));

vi.mock("@react-email/render", () => ({
  render: vi.fn().mockResolvedValue("<html>mock</html>"),
}));

import { FieldValue } from "firebase-admin/firestore";
import { clearFirestore, fakeRequest, testDb } from "./_setup";
import { createInvoiceHandler } from "../../src/invoices/createInvoice";
import { updateInvoiceHandler } from "../../src/invoices/updateInvoice";
import { markInvoicePaidHandler } from "../../src/invoices/markInvoicePaid";
import { voidInvoiceHandler } from "../../src/invoices/voidInvoice";
import { regenerateInvoicePayLinkHandler } from "../../src/invoices/regenerateInvoicePayLink";
import { sendInvoiceEmailHandler } from "../../src/invoices/sendInvoiceEmail";

const TENANT = "acme-plumbing";

function member(role: "owner" | "admin" | "staff") {
  return {
    uid: `u_${role}`,
    claims: { email: `${role}@acme.test`, tenantId: TENANT, role },
  };
}
const ownerAuth = member("owner");

function validInvoiceData(overrides: Record<string, unknown> = {}) {
  return {
    customer: { name: "Jane Doe", email: "Jane@Example.COM", phone: "555-1234" },
    lineItems: [{ description: "Kitchen faucet install", quantity: 2, rate: 150 }],
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

function invoiceRef(invoiceId: string) {
  return testDb.doc(`tenants/${TENANT}/invoices/${invoiceId}`);
}

async function invoiceWithStatus(status: string): Promise<string> {
  const { invoiceId } = await createInvoiceHandler(
    fakeRequest(validInvoiceData(), ownerAuth),
  );
  if (status !== "draft") await invoiceRef(invoiceId).update({ status });
  return invoiceId;
}

beforeEach(async () => {
  await clearFirestore();
  await seedTenant();
  mockSesSend.mockClear();
});

describe("voidInvoice", () => {
  it.each(["sent", "unpaid", "overdue"])(
    "voids a %s invoice and keeps the record",
    async (status) => {
      const invoiceId = await invoiceWithStatus(status);

      const res = await voidInvoiceHandler(
        fakeRequest({ invoiceId, reason: "  Billed the wrong customer " }, ownerAuth),
      );
      expect(res).toEqual({ invoiceId, status: "void", changed: true });

      const inv = (await invoiceRef(invoiceId).get()).data()!;
      expect(inv.status).toBe("void");
      expect(inv.voidedAt).toBeTruthy();
      expect(inv.voidedBy).toBe("u_owner");
      expect(inv.voidReason).toBe("Billed the wrong customer");
      expect(inv.customer.email).toBe("jane@example.com");
      expect(inv.totals.total).toBe(339);
    },
  );

  it("lets an admin void, and voiding again changes nothing", async () => {
    const invoiceId = await invoiceWithStatus("sent");

    await voidInvoiceHandler(fakeRequest({ invoiceId }, member("admin")));
    const inv = (await invoiceRef(invoiceId).get()).data()!;
    expect(inv.voidedBy).toBe("u_admin");
    expect(inv.voidReason).toBeNull();

    await expect(
      voidInvoiceHandler(fakeRequest({ invoiceId }, ownerAuth)),
    ).resolves.toEqual({ invoiceId, status: "void", changed: false });
    expect((await invoiceRef(invoiceId).get()).data()!.voidedBy).toBe("u_admin");
  });

  it("rejects staff", async () => {
    const invoiceId = await invoiceWithStatus("sent");
    await expect(
      voidInvoiceHandler(fakeRequest({ invoiceId }, member("staff"))),
    ).rejects.toThrow(/Requires one of/);
    expect((await invoiceRef(invoiceId).get()).data()!.status).toBe("sent");
  });

  it("refuses a draft, which is deleted instead", async () => {
    const invoiceId = await invoiceWithStatus("draft");
    await expect(
      voidInvoiceHandler(fakeRequest({ invoiceId }, ownerAuth)),
    ).rejects.toThrow(/delete the draft instead/);
    expect((await invoiceRef(invoiceId).get()).data()!.status).toBe("draft");
  });

  it.each(["partial", "paid", "refunded", "partially-refunded"])(
    "refuses a %s invoice, which has a recorded payment",
    async (status) => {
      const invoiceId = await invoiceWithStatus(status);
      await expect(
        voidInvoiceHandler(fakeRequest({ invoiceId }, ownerAuth)),
      ).rejects.toThrow(`with a recorded payment (${status}) can't be voided`);
      expect((await invoiceRef(invoiceId).get()).data()!.status).toBe(status);
    },
  );

  it("validates the invoice id and the reason", async () => {
    await expect(
      voidInvoiceHandler(fakeRequest({}, ownerAuth)),
    ).rejects.toThrow(/invoiceId required/);
    await expect(
      voidInvoiceHandler(
        fakeRequest({ invoiceId: "INV-0001/payAttempts/a" }, ownerAuth),
      ),
    ).rejects.toThrow(/invoiceId is invalid/);

    const invoiceId = await invoiceWithStatus("sent");
    await expect(
      voidInvoiceHandler(
        fakeRequest({ invoiceId, reason: "x".repeat(501) }, ownerAuth),
      ),
    ).rejects.toThrow(/reason must be ≤500 characters/);
  });

  it("answers not-found for an unknown invoice", async () => {
    await expect(
      voidInvoiceHandler(fakeRequest({ invoiceId: "INV-9999" }, ownerAuth)),
    ).rejects.toThrow(/Invoice not found/);
  });
});

describe("a void invoice is final", () => {
  let invoiceId: string;

  beforeEach(async () => {
    invoiceId = await invoiceWithStatus("sent");
    await voidInvoiceHandler(fakeRequest({ invoiceId }, ownerAuth));
  });

  it("can't be marked paid", async () => {
    await expect(
      markInvoicePaidHandler(fakeRequest({ invoiceId }, ownerAuth)),
    ).rejects.toThrow(/Cannot mark a void invoice as paid/);
    expect((await invoiceRef(invoiceId).get()).data()!.status).toBe("void");
  });

  it("can't be edited", async () => {
    await expect(
      updateInvoiceHandler(
        fakeRequest({ ...validInvoiceData(), invoiceId }, ownerAuth),
      ),
    ).rejects.toThrow(/Cannot update an invoice with status 'void'/);
  });

  it("can't be sent", async () => {
    await expect(
      sendInvoiceEmailHandler(fakeRequest({ invoiceId }, ownerAuth)),
    ).rejects.toThrow(/void and can't be sent/);
    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it("can't be given a new pay link", async () => {
    const before = (await invoiceRef(invoiceId).get()).data()!;
    await expect(
      regenerateInvoicePayLinkHandler(fakeRequest({ invoiceId }, ownerAuth)),
    ).rejects.toThrow(/Cannot issue a pay link for a void invoice/);
    const after = (await invoiceRef(invoiceId).get()).data()!;
    expect(after.payTokenVersion).toBe(before.payTokenVersion);
    expect(after.payToken).toBe(before.payToken);
  });
});

describe("markInvoicePaid accepts only payable invoices", () => {
  it.each(["refunded", "partially-refunded"])(
    "refuses a %s invoice",
    async (status) => {
      const invoiceId = await invoiceWithStatus(status);
      await expect(
        markInvoicePaidHandler(fakeRequest({ invoiceId }, ownerAuth)),
      ).rejects.toThrow(`Cannot mark a ${status} invoice as paid`);
      expect((await invoiceRef(invoiceId).get()).data()!.status).toBe(status);
    },
  );

  it.each(["unpaid", "overdue", "partial"])(
    "still records a manual payment on a %s invoice",
    async (status) => {
      const invoiceId = await invoiceWithStatus(status);
      await expect(
        markInvoicePaidHandler(
          fakeRequest({ invoiceId, paymentMethod: "cash" }, ownerAuth),
        ),
      ).resolves.toEqual({ invoiceId, status: "paid" });
    },
  );
});
