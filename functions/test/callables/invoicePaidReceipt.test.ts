// E-01 — onInvoicePaid: the customer gets a receipt when an invoice becomes
// paid (card payments always; recorded payments when the owner asks).

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSesSend = vi.fn();
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: vi.fn().mockImplementation(() => ({ send: mockSesSend })),
  SendEmailCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ input })),
}));

vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => `test-${name}` }),
}));

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { Timestamp } from "firebase-admin/firestore";
import { clearFirestore, fakeRequest, testDb } from "./_setup";
import { handleInvoicePaid } from "../../src/invoices/onInvoicePaid";
import { markInvoicePaidHandler } from "../../src/invoices/markInvoicePaid";

const TENANT = "acme-plumbing";
const INVOICE = "INV-0001";
const PAID_AT = Timestamp.fromDate(new Date("2026-09-13T15:30:00Z"));

function sentInvoice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customer: { name: "Jane Doe", email: "jane@example.com", phone: null },
    totals: { subtotal: 100, taxAmount: 13, total: 113 },
    tenantSnapshot: {
      name: "Acme Plumbing",
      address: "123 Main St",
      logo: null,
      logoUrl: null,
      logoContentType: null,
      primaryColor: "#0066CC",
      currency: "CAD",
      emailFooter: null,
    },
    status: "sent",
    ...overrides,
  };
}

function paidInvoice(overrides: Record<string, unknown> = {}) {
  return sentInvoice({ status: "paid", paidAt: PAID_AT, ...overrides });
}

function change(after: Record<string, unknown>, before = sentInvoice()) {
  return { tenantId: TENANT, invoiceId: INVOICE, before, after };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sentEmails(): any[] {
  return mockSesSend.mock.calls.map((call) => call[0].input);
}

beforeEach(async () => {
  await clearFirestore();
  mockSesSend.mockReset();
  mockSesSend.mockResolvedValue({ MessageId: "ses-receipt" });
  await testDb.doc(`tenants/${TENANT}/meta/settings`).set({
    name: "Acme Plumbing",
    contactEmail: "office@acme.test",
    etransferEmail: "pay@acme.test",
  });
});

describe("handleInvoicePaid (E-01)", () => {
  it("emails the customer a receipt for a card payment, card fee included", async () => {
    const result = await handleInvoicePaid(
      change(
        paidInvoice({
          paymentMethod: "card",
          paidAmountCents: 11300,
          surchargeAmountCents: 271,
        }),
      ),
    );

    expect(result).toEqual({ sent: true });
    expect(sentEmails()).toHaveLength(1);
    const req = sentEmails()[0];
    expect(req.Destination.ToAddresses).toEqual(["jane@example.com"]);
    expect(req.Content.Simple.Subject.Data).toBe(
      "Receipt for invoice INV-0001 from Acme Plumbing",
    );
    expect(req.FromEmailAddress).toBe(
      '"Acme Plumbing" <notifications@techflowsolutions.ca>',
    );
    expect(req.ReplyToAddresses).toEqual(["office@acme.test"]);
    expect(req.EmailTags).toEqual(
      expect.arrayContaining([
        { Name: "category", Value: "payment-receipt" },
        { Name: "tenantId", Value: TENANT },
        { Name: "documentId", Value: INVOICE },
      ]),
    );

    const text = req.Content.Simple.Body.Text.Data as string;
    expect(text).toContain("Amount paid: $115.71");
    expect(text).toContain("Includes a $2.71 credit card fee");
    expect(text).toContain("Payment method: Credit card");
    expect(text).toContain("Paid on: September 13, 2026");
  });

  it("sends one receipt when the trigger is delivered twice", async () => {
    const event = change(
      paidInvoice({ paymentMethod: "card", paidAmountCents: 11300, surchargeAmountCents: 0 }),
    );

    await handleInvoicePaid(event);
    await expect(handleInvoicePaid(event)).resolves.toEqual({
      sent: false,
      reason: "already-sent",
    });
    expect(mockSesSend).toHaveBeenCalledTimes(1);
  });

  it("doesn't email about a payment the business recorded unless asked", async () => {
    await expect(
      handleInvoicePaid(change(paidInvoice({ paymentMethod: "etransfer" }))),
    ).resolves.toEqual({ sent: false, reason: "not-requested" });
    await expect(
      handleInvoicePaid(
        change(paidInvoice({ paymentMethod: "cash", receiptRequested: false })),
      ),
    ).resolves.toEqual({ sent: false, reason: "not-requested" });
    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it("emails a receipt for a recorded payment when the owner asked for one", async () => {
    const result = await handleInvoicePaid(
      change(paidInvoice({ paymentMethod: "etransfer", receiptRequested: true })),
    );

    expect(result).toEqual({ sent: true });
    const text = sentEmails()[0].Content.Simple.Body.Text.Data as string;
    expect(text).toContain("Amount paid: $113.00");
    expect(text).toContain("Payment method: Interac e-Transfer");
    expect(text).not.toContain("credit card fee");
  });

  it("ignores updates that aren't a new payment", async () => {
    const alreadyPaid = paidInvoice({ paymentMethod: "card", paidAmountCents: 11300 });
    await expect(
      handleInvoicePaid(change({ ...alreadyPaid, disputed: true }, alreadyPaid)),
    ).resolves.toEqual({ sent: false, reason: "not-a-new-payment" });
    await expect(
      handleInvoicePaid(change(sentInvoice({ notes: "edited" }))),
    ).resolves.toEqual({ sent: false, reason: "not-a-new-payment" });
    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it("skips an invoice without a valid customer email", async () => {
    await expect(
      handleInvoicePaid(
        change(
          paidInvoice({
            paymentMethod: "card",
            paidAmountCents: 11300,
            customer: { name: "Jane Doe", email: "" },
          }),
        ),
      ),
    ).resolves.toEqual({ sent: false, reason: "no-customer-email" });
    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it("reports a failed send without throwing", async () => {
    mockSesSend.mockRejectedValueOnce(new Error("Throttling"));
    await expect(
      handleInvoicePaid(
        change(paidInvoice({ paymentMethod: "card", paidAmountCents: 11300 })),
      ),
    ).resolves.toEqual({ sent: false, reason: "send-failed" });
  });
});

describe("markInvoicePaid records whether the owner asked for a receipt (E-01)", () => {
  const ownerAuth = {
    uid: "u_owner",
    claims: { email: "owner@acme.test", tenantId: TENANT, role: "owner" as const },
  };

  it.each([
    [true, true],
    [undefined, false],
    ["yes", false],
  ])("sendReceipt %j → receiptRequested %j", async (sendReceipt, expected) => {
    const ref = testDb.doc(`tenants/${TENANT}/invoices/${INVOICE}`);
    await ref.set(sentInvoice());

    await markInvoicePaidHandler(
      fakeRequest({ invoiceId: INVOICE, paymentMethod: "etransfer", sendReceipt }, ownerAuth),
    );

    const data = (await ref.get()).data()!;
    expect(data.status).toBe("paid");
    expect(data.receiptRequested).toBe(expected);
  });
});
