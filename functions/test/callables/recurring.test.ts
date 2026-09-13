import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be set before handler imports
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-pay-token-secret-256bit-min!!";

vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({
    value: () => {
      if (name === "PAY_TOKEN_SECRET") return TEST_SECRET;
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

import {
  clearFirestore,
  fakeRequest,
  testDb,
} from "./_setup";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { createRecurringInvoiceHandler } from "../../src/recurring/createRecurringInvoice";
import { processRecurringInvoicesHandler } from "../../src/recurring/processRecurringInvoices";
import { updateRecurringInvoiceHandler } from "../../src/recurring/updateRecurringInvoice";
import {
  computeNextRunAt,
  computeResumeRunAt,
  extractAnchorDay,
  addDaysToISODate,
} from "../../src/shared/recurring";

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

const validInput = {
  customer: { name: "Jane Doe", email: "JANE@example.com", phone: "555-1234" },
  lineItems: [{ description: "Monthly cleaning", quantity: 1, rate: 200 }],
  applyTax: true,
  notes: "Monthly service",
  internalDescription: "Jane's monthly cleaning contract",
  daysUntilDue: 30,
  interval: "monthly",
  startDate: "2026-05-15",
  endAfterCount: 12,
  endDate: null,
  autoSend: false,
};

async function seedTenant(opts?: {
  recurringFeature?: boolean;
}): Promise<void> {
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
    plan: "pro",
    features: { recurringInvoices: opts?.recurringFeature ?? true },
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
}

async function seedRecurringTemplate(overrides?: Record<string, unknown>): Promise<string> {
  const ref = testDb.collection(`tenants/${TENANT}/recurringInvoices`).doc();
  const past = Timestamp.fromDate(new Date("2026-04-01T00:00:00Z"));
  await ref.set({
    customer: { name: "Jane Doe", email: "jane@example.com", phone: null },
    lineItems: [
      { description: "Monthly cleaning", quantity: 1, rate: 200, amount: 200 },
    ],
    applyTax: true,
    totals: { subtotal: 200, taxRate: 0.13, taxAmount: 26, total: 226 },
    notes: null,
    internalDescription: "Jane monthly",
    daysUntilDue: 30,
    interval: "monthly",
    anchorDay: 1,
    startDate: "2026-04-01",
    nextRunAt: past,
    endAfterCount: null,
    endDate: null,
    autoSend: false,
    status: "active",
    createdAt: FieldValue.serverTimestamp(),
    createdBy: OWNER_UID,
    updatedAt: null,
    pausedAt: null,
    cancelledAt: null,
    generatedCount: 0,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    consecutiveFailures: 0,
    lastGeneratedInvoiceId: null,
    ...overrides,
  });
  return ref.id;
}

// ---------------------------------------------------------------------------
// Unit tests — scheduling helpers
// ---------------------------------------------------------------------------

describe("computeNextRunAt", () => {
  it("weekly: advances by 7 days", () => {
    const d = new Date("2026-04-15T00:00:00Z");
    const next = computeNextRunAt(d, "weekly", 15);
    expect(next.toISOString()).toBe("2026-04-22T00:00:00.000Z");
  });

  it("biweekly: advances by 14 days", () => {
    const d = new Date("2026-04-01T00:00:00Z");
    const next = computeNextRunAt(d, "biweekly", 1);
    expect(next.toISOString()).toBe("2026-04-15T00:00:00.000Z");
  });

  it("monthly: same day next month", () => {
    const d = new Date("2026-04-15T00:00:00Z");
    const next = computeNextRunAt(d, "monthly", 15);
    expect(next.toISOString()).toBe("2026-05-15T00:00:00.000Z");
  });

  it("monthly: clamps anchorDay 31 to 30 in April", () => {
    const d = new Date("2026-03-31T00:00:00Z");
    const next = computeNextRunAt(d, "monthly", 31);
    expect(next.toISOString()).toBe("2026-04-30T00:00:00.000Z");
  });

  it("monthly: Feb 29 clamps to Feb 28 on non-leap year (2027)", () => {
    const d = new Date("2027-01-29T00:00:00Z");
    const next = computeNextRunAt(d, "monthly", 29);
    // Feb 2027 is NOT a leap year → 28 days
    expect(next.toISOString()).toBe("2027-02-28T00:00:00.000Z");
  });

  it("monthly: Feb 29 stays Feb 29 on leap year (2028)", () => {
    const d = new Date("2028-01-29T00:00:00Z");
    const next = computeNextRunAt(d, "monthly", 29);
    // Feb 2028 IS a leap year → 29 days
    expect(next.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("quarterly: advances by 3 months", () => {
    const d = new Date("2026-01-15T00:00:00Z");
    const next = computeNextRunAt(d, "quarterly", 15);
    expect(next.toISOString()).toBe("2026-04-15T00:00:00.000Z");
  });

  it("quarterly: clamps anchorDay 31 in months with fewer days", () => {
    // Nov 30 → Feb (quarterly). Feb has 28 days in 2027.
    const d = new Date("2026-11-30T00:00:00Z");
    const next = computeNextRunAt(d, "quarterly", 30);
    expect(next.toISOString()).toBe("2027-02-28T00:00:00.000Z");
  });

  it("annually: advances by 12 months", () => {
    const d = new Date("2026-06-15T00:00:00Z");
    const next = computeNextRunAt(d, "annually", 15);
    expect(next.toISOString()).toBe("2027-06-15T00:00:00.000Z");
  });

  it("annually: Feb 29 leap → Feb 28 non-leap", () => {
    const d = new Date("2028-02-29T00:00:00Z");
    const next = computeNextRunAt(d, "annually", 29);
    // 2029 is NOT a leap year
    expect(next.toISOString()).toBe("2029-02-28T00:00:00.000Z");
  });

  it("annually: Feb 28 non-leap → Feb 29 if anchorDay 29 and next year is leap", () => {
    const d = new Date("2027-02-28T00:00:00Z");
    const next = computeNextRunAt(d, "annually", 29);
    // 2028 IS a leap year, anchorDay is 29
    expect(next.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
});

describe("computeResumeRunAt (A-10)", () => {
  it("keeps a scheduled run that is still in the future", () => {
    const next = computeResumeRunAt(
      new Date("2026-05-15T00:00:00Z"),
      new Date("2026-04-20T12:00:00Z"),
      "monthly",
      15,
    );
    expect(next.toISOString()).toBe("2026-05-15T00:00:00.000Z");
  });

  it("monthly: skips missed periods and keeps the anchor day", () => {
    // Jan 31 → Feb 28 → Mar 31 → Apr 30 (first slot after Apr 10).
    const next = computeResumeRunAt(
      new Date("2026-01-31T00:00:00Z"),
      new Date("2026-04-10T09:00:00Z"),
      "monthly",
      31,
    );
    expect(next.toISOString()).toBe("2026-04-30T00:00:00.000Z");
  });

  it("never re-runs today's slot once it has passed", () => {
    const next = computeResumeRunAt(
      new Date("2026-04-15T00:00:00Z"),
      new Date("2026-04-15T03:00:00Z"),
      "monthly",
      15,
    );
    expect(next.toISOString()).toBe("2026-05-15T00:00:00.000Z");
  });

  it("weekly: keeps the weekday and midnight UTC", () => {
    // 2026-04-06 is a Monday; resuming on a Monday afternoon.
    const next = computeResumeRunAt(
      new Date("2026-04-06T00:00:00Z"),
      new Date("2026-04-20T14:30:00Z"),
      "weekly",
      6,
    );
    expect(next.toISOString()).toBe("2026-04-27T00:00:00.000Z");
    expect(next.getUTCDay()).toBe(1);
  });

  it("biweekly: stays on the original fortnight", () => {
    // Apr 1 → Apr 15 → Apr 29 → May 13.
    const next = computeResumeRunAt(
      new Date("2026-04-01T00:00:00Z"),
      new Date("2026-05-02T00:00:00Z"),
      "biweekly",
      1,
    );
    expect(next.toISOString()).toBe("2026-05-13T00:00:00.000Z");
  });

  it("annually: a Feb 29 anchor clamps on non-leap years", () => {
    // 2028-02-29 → 2029-02-28 → 2030-02-28 → 2031-02-28.
    const next = computeResumeRunAt(
      new Date("2028-02-29T00:00:00Z"),
      new Date("2030-03-01T00:00:00Z"),
      "annually",
      29,
    );
    expect(next.toISOString()).toBe("2031-02-28T00:00:00.000Z");
  });
});

describe("extractAnchorDay", () => {
  it("extracts day from ISO date", () => {
    expect(extractAnchorDay("2026-04-15")).toBe(15);
    expect(extractAnchorDay("2026-01-31")).toBe(31);
    expect(extractAnchorDay("2026-02-01")).toBe(1);
  });
});

describe("addDaysToISODate", () => {
  it("adds days and returns ISO date string", () => {
    expect(addDaysToISODate("2026-04-15", 30)).toBe("2026-05-15");
    expect(addDaysToISODate("2026-01-31", 1)).toBe("2026-02-01");
  });
});

// ---------------------------------------------------------------------------
// createRecurringInvoice
// ---------------------------------------------------------------------------

describe("createRecurringInvoice", () => {
  beforeEach(async () => {
    await clearFirestore();
    mockSesSend.mockClear();
  });

  it("rejects unauthenticated calls", async () => {
    await expect(
      createRecurringInvoiceHandler(fakeRequest(validInput, null)),
    ).rejects.toThrow(/sign in required/i);
  });

  it("rejects calls without tenantId", async () => {
    await expect(
      createRecurringInvoiceHandler(
        fakeRequest(validInput, {
          uid: "u1",
          claims: { email: "a@b.com", email_verified: true },
        }),
      ),
    ).rejects.toThrow(/tenant membership required/i);
  });

  it("rejects when recurringInvoices feature is disabled", async () => {
    await seedTenant({ recurringFeature: false });
    await expect(
      createRecurringInvoiceHandler(fakeRequest(validInput, ownerAuth)),
    ).rejects.toThrow(/not enabled/i);
  });

  it("validates required fields", async () => {
    await seedTenant();
    // Missing customer
    await expect(
      createRecurringInvoiceHandler(fakeRequest({}, ownerAuth)),
    ).rejects.toThrow();

    // Invalid interval
    await expect(
      createRecurringInvoiceHandler(
        fakeRequest({ ...validInput, interval: "daily" }, ownerAuth),
      ),
    ).rejects.toThrow(/interval/i);

    // Missing startDate
    await expect(
      createRecurringInvoiceHandler(
        fakeRequest({ ...validInput, startDate: "" }, ownerAuth),
      ),
    ).rejects.toThrow(/startDate/i);

    // Negative daysUntilDue
    await expect(
      createRecurringInvoiceHandler(
        fakeRequest({ ...validInput, daysUntilDue: -1 }, ownerAuth),
      ),
    ).rejects.toThrow(/daysUntilDue/i);

    // internalDescription too long
    await expect(
      createRecurringInvoiceHandler(
        fakeRequest(
          { ...validInput, internalDescription: "x".repeat(201) },
          ownerAuth,
        ),
      ),
    ).rejects.toThrow(/internalDescription/i);
  });

  it("creates a recurring invoice template with correct fields", async () => {
    await seedTenant();
    const { recurringInvoiceId } = await createRecurringInvoiceHandler(
      fakeRequest(validInput, ownerAuth),
    );

    expect(recurringInvoiceId).toBeTruthy();

    const doc = await testDb
      .doc(`tenants/${TENANT}/recurringInvoices/${recurringInvoiceId}`)
      .get();
    expect(doc.exists).toBe(true);

    const data = doc.data()!;
    // Customer email lowercased
    expect(data.customer.email).toBe("jane@example.com");
    expect(data.customer.name).toBe("Jane Doe");
    expect(data.customer.phone).toBe("555-1234");

    // Server-computed totals
    expect(data.totals.subtotal).toBe(200);
    expect(data.totals.taxRate).toBe(0.13);
    expect(data.totals.taxAmount).toBe(26);
    expect(data.totals.total).toBe(226);

    // Line items have server-computed amount
    expect(data.lineItems[0].amount).toBe(200);

    // Scheduling
    expect(data.interval).toBe("monthly");
    expect(data.anchorDay).toBe(15);
    expect(data.startDate).toBe("2026-05-15");
    expect(data.daysUntilDue).toBe(30);

    // Completion bounds
    expect(data.endAfterCount).toBe(12);
    expect(data.endDate).toBeNull();

    // Behavior
    expect(data.autoSend).toBe(false);

    // Lifecycle
    expect(data.status).toBe("active");
    expect(data.createdBy).toBe(OWNER_UID);
    expect(data.pausedAt).toBeNull();
    expect(data.cancelledAt).toBeNull();

    // Run tracking (initial state)
    expect(data.generatedCount).toBe(0);
    expect(data.lastRunAt).toBeNull();
    expect(data.lastRunStatus).toBeNull();
    expect(data.lastRunError).toBeNull();
    expect(data.consecutiveFailures).toBe(0);
    expect(data.lastGeneratedInvoiceId).toBeNull();

    // Internal description
    expect(data.internalDescription).toBe(
      "Jane's monthly cleaning contract",
    );

    // Notes
    expect(data.notes).toBe("Monthly service");
  });

  it("sets nextRunAt from startDate", async () => {
    await seedTenant();
    const { recurringInvoiceId } = await createRecurringInvoiceHandler(
      fakeRequest(validInput, ownerAuth),
    );

    const doc = await testDb
      .doc(`tenants/${TENANT}/recurringInvoices/${recurringInvoiceId}`)
      .get();
    const nextRunAt = doc.data()!.nextRunAt as Timestamp;
    expect(nextRunAt.toDate().toISOString()).toBe("2026-05-15T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// processRecurringInvoices
// ---------------------------------------------------------------------------

describe("processRecurringInvoices", () => {
  beforeEach(async () => {
    await clearFirestore();
    mockSesSend.mockClear();
  });

  it("does nothing when no templates are due", async () => {
    await seedTenant();
    // Seed a template with nextRunAt in the future
    await seedRecurringTemplate({
      nextRunAt: Timestamp.fromDate(new Date("2099-01-01T00:00:00Z")),
    });
    await processRecurringInvoicesHandler();

    // No invoices created
    const invoices = await testDb
      .collection(`tenants/${TENANT}/invoices`)
      .get();
    expect(invoices.size).toBe(0);
  });

  it("generates an invoice for a due template", async () => {
    await seedTenant();
    const templateId = await seedRecurringTemplate();
    await processRecurringInvoicesHandler();

    // Invoice should exist
    const invoices = await testDb
      .collection(`tenants/${TENANT}/invoices`)
      .get();
    expect(invoices.size).toBe(1);

    const invoice = invoices.docs[0].data();
    expect(invoice.customer.email).toBe("jane@example.com");
    expect(invoice.sourceRecurringInvoiceId).toBe(templateId);
    expect(invoice.status).toBe("draft");
    expect(invoice.createdBy).toBe("system:recurring-processor");
    expect(invoice.payToken).toBeTruthy();
    expect(invoice.payTokenVersion).toBe(1);

    // Server-recomputed totals from current meta.taxRate
    expect(invoice.totals.subtotal).toBe(200);
    expect(invoice.totals.taxRate).toBe(0.13);
    expect(invoice.totals.total).toBe(226);

    // Has fresh tenantSnapshot
    expect(invoice.tenantSnapshot.name).toBe("Acme Plumbing");
    expect(invoice.tenantSnapshot.version).toBe(1);

    // Template advanced
    const templateDoc = await testDb
      .doc(`tenants/${TENANT}/recurringInvoices/${templateId}`)
      .get();
    const tData = templateDoc.data()!;
    expect(tData.generatedCount).toBe(1);
    expect(tData.lastRunStatus).toBe("success");
    expect(tData.lastRunError).toBeNull();
    expect(tData.consecutiveFailures).toBe(0);
    expect(tData.lastGeneratedInvoiceId).toBe(invoices.docs[0].id);

    // nextRunAt advanced to next month (May 1)
    const nextRun = (tData.nextRunAt as Timestamp).toDate();
    expect(nextRun.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("honours per-line taxable flags from the template (D4)", async () => {
    await seedTenant();
    await seedRecurringTemplate({
      lineItems: [
        { description: "Monthly cleaning", quantity: 1, rate: 200, taxable: true, amount: 200 },
        { description: "Exempt service", quantity: 1, rate: 100, taxable: false, amount: 100 },
      ],
    });
    await processRecurringInvoicesHandler();

    const invoice = (
      await testDb.collection(`tenants/${TENANT}/invoices`).get()
    ).docs[0].data();
    expect(invoice.lineItems[1].taxable).toBe(false);
    expect(invoice.totals.subtotal).toBe(300);
    expect(invoice.totals.taxableSubtotal).toBe(200);
    expect(invoice.totals.taxAmount).toBe(26);
    expect(invoice.totals.total).toBe(326);
    expect(invoice.totals.taxes).toEqual([
      { name: "HST", rate: 0.13, taxableAmount: 200, amount: 26 },
    ]);
  });

  it("increments invoice counter correctly", async () => {
    await seedTenant();
    // Set counter to 5
    await testDb
      .doc(`tenants/${TENANT}/counters/invoice`)
      .set({ value: 5, updatedAt: FieldValue.serverTimestamp() });

    await seedRecurringTemplate();
    await processRecurringInvoicesHandler();

    // Invoice ID should be INV-0006
    const invoices = await testDb
      .collection(`tenants/${TENANT}/invoices`)
      .get();
    expect(invoices.docs[0].id).toBe("INV-0006");

    // Counter advanced to 6
    const counter = await testDb
      .doc(`tenants/${TENANT}/counters/invoice`)
      .get();
    expect(counter.data()!.value).toBe(6);
  });

  it("skips when recurringInvoices feature is disabled", async () => {
    await seedTenant({ recurringFeature: false });
    const templateId = await seedRecurringTemplate();
    await processRecurringInvoicesHandler();

    // No invoices created
    const invoices = await testDb
      .collection(`tenants/${TENANT}/invoices`)
      .get();
    expect(invoices.size).toBe(0);

    // Template status unchanged, lastRunStatus = skipped
    const doc = await testDb
      .doc(`tenants/${TENANT}/recurringInvoices/${templateId}`)
      .get();
    const data = doc.data()!;
    expect(data.status).toBe("active");
    expect(data.lastRunStatus).toBe("skipped");
  });

  it("skips paused templates", async () => {
    await seedTenant();
    await seedRecurringTemplate({ status: "paused" });
    await processRecurringInvoicesHandler();

    const invoices = await testDb
      .collection(`tenants/${TENANT}/invoices`)
      .get();
    expect(invoices.size).toBe(0);
  });

  it("transitions to completed when endAfterCount is reached", async () => {
    await seedTenant();
    const templateId = await seedRecurringTemplate({
      endAfterCount: 1,
      generatedCount: 0,
    });
    await processRecurringInvoicesHandler();

    // Invoice created
    const invoices = await testDb
      .collection(`tenants/${TENANT}/invoices`)
      .get();
    expect(invoices.size).toBe(1);

    // Template now completed
    const doc = await testDb
      .doc(`tenants/${TENANT}/recurringInvoices/${templateId}`)
      .get();
    expect(doc.data()!.status).toBe("completed");
  });

  it("transitions to completed when endDate is past", async () => {
    await seedTenant();
    const templateId = await seedRecurringTemplate({
      nextRunAt: Timestamp.fromDate(new Date("2026-04-01T00:00:00Z")),
      endDate: "2026-03-31", // endDate before nextRunAt
    });
    await processRecurringInvoicesHandler();

    // No invoice created — endDate check fires before generation
    const invoices = await testDb
      .collection(`tenants/${TENANT}/invoices`)
      .get();
    expect(invoices.size).toBe(0);

    // Template completed
    const doc = await testDb
      .doc(`tenants/${TENANT}/recurringInvoices/${templateId}`)
      .get();
    expect(doc.data()!.status).toBe("completed");
  });

  it("sends email when autoSend is true", async () => {
    await seedTenant();
    await seedRecurringTemplate({ autoSend: true });
    await processRecurringInvoicesHandler();

    // Email sent through SES, tagged for bounce tracking (D5)
    expect(mockSesSend).toHaveBeenCalledTimes(1);
    const call = mockSesSend.mock.calls[0][0].input;
    expect(call.Destination.ToAddresses).toEqual(["jane@example.com"]);
    expect(call.Content.Simple.Subject.Data).toMatch(/Invoice.*Acme Plumbing/);
    expect(call.ReplyToAddresses).toEqual(["pay@acme.test"]);
    expect(call.EmailTags).toContainEqual({
      Name: "category",
      Value: "recurring-invoice",
    });

    // Invoice status transitioned to "sent"
    const invoices = await testDb
      .collection(`tenants/${TENANT}/invoices`)
      .get();
    expect(invoices.docs[0].data().status).toBe("sent");
  });

  it("does not send email when autoSend is false", async () => {
    await seedTenant();
    await seedRecurringTemplate({ autoSend: false });
    await processRecurringInvoicesHandler();

    expect(mockSesSend).not.toHaveBeenCalled();

    const invoices = await testDb
      .collection(`tenants/${TENANT}/invoices`)
      .get();
    expect(invoices.docs[0].data().status).toBe("draft");
  });

  it("records failure and increments consecutiveFailures", async () => {
    // Seed template but NO tenant meta → will fail at meta read
    await testDb.doc(`tenants/${TENANT}/entitlements/current`).set({
      plan: "pro",
      features: { recurringInvoices: true },
      updatedAt: FieldValue.serverTimestamp(),
    });
    const templateId = await seedRecurringTemplate();
    await processRecurringInvoicesHandler();

    const doc = await testDb
      .doc(`tenants/${TENANT}/recurringInvoices/${templateId}`)
      .get();
    const data = doc.data()!;
    expect(data.lastRunStatus).toBe("failed");
    expect(data.lastRunError).toMatch(/meta not found/i);
    expect(data.consecutiveFailures).toBe(1);
    expect(data.status).toBe("active"); // not paused yet
  });

  it("auto-pauses after 3 consecutive failures", async () => {
    // Seed template with 2 consecutive failures + no tenant meta
    await testDb.doc(`tenants/${TENANT}/entitlements/current`).set({
      plan: "pro",
      features: { recurringInvoices: true },
      updatedAt: FieldValue.serverTimestamp(),
    });
    const templateId = await seedRecurringTemplate({
      consecutiveFailures: 2,
    });
    await processRecurringInvoicesHandler();

    const doc = await testDb
      .doc(`tenants/${TENANT}/recurringInvoices/${templateId}`)
      .get();
    const data = doc.data()!;
    expect(data.status).toBe("paused");
    expect(data.pausedAt).toBeTruthy();
    expect(data.consecutiveFailures).toBe(3);
    expect(data.lastRunError).toMatch(/auto-paused/i);
  });

  it("resets consecutiveFailures on success after prior failures", async () => {
    await seedTenant();
    const templateId = await seedRecurringTemplate({
      consecutiveFailures: 2,
      lastRunStatus: "failed",
      lastRunError: "some prior error",
    });
    await processRecurringInvoicesHandler();

    const doc = await testDb
      .doc(`tenants/${TENANT}/recurringInvoices/${templateId}`)
      .get();
    const data = doc.data()!;
    expect(data.consecutiveFailures).toBe(0);
    expect(data.lastRunStatus).toBe("success");
    expect(data.lastRunError).toBeNull();
  });

  it("computes dueDate from issueDate + daysUntilDue", async () => {
    await seedTenant();
    await seedRecurringTemplate({ daysUntilDue: 15 });
    await processRecurringInvoicesHandler();

    const invoices = await testDb
      .collection(`tenants/${TENANT}/invoices`)
      .get();
    const invoice = invoices.docs[0].data();
    const issueDate = invoice.issueDate;
    const dueDate = invoice.dueDate;

    // dueDate should be issueDate + 15 days
    const expected = addDaysToISODate(issueDate, 15);
    expect(dueDate).toBe(expected);
  });

  it("uses fresh tenant meta taxRate for totals", async () => {
    await seedTenant();
    // Update tenant taxRate to 0.05 (different from template's stored totals)
    await testDb.doc(`tenants/${TENANT}/meta/settings`).update({
      taxRate: 0.05,
    });

    await seedRecurringTemplate();
    await processRecurringInvoicesHandler();

    const invoices = await testDb
      .collection(`tenants/${TENANT}/invoices`)
      .get();
    const invoice = invoices.docs[0].data();
    // subtotal 200, taxRate 0.05, taxAmount 10, total 210
    expect(invoice.totals.taxRate).toBe(0.05);
    expect(invoice.totals.taxAmount).toBe(10);
    expect(invoice.totals.total).toBe(210);
  });
});

// ---------------------------------------------------------------------------
// updateRecurringInvoice (A-10)
// ---------------------------------------------------------------------------

describe("updateRecurringInvoice (A-10)", () => {
  const staffAuth = {
    uid: "u_staff",
    claims: { email: "staff@acme.test", tenantId: TENANT, role: "staff" as const },
  };
  const adminAuth = {
    uid: "u_admin",
    claims: { email: "admin@acme.test", tenantId: TENANT, role: "admin" as const },
  };
  const outsiderAuth = {
    uid: "u_outsider",
    claims: { email: "owner@other.test", tenantId: "other-tenant", role: "owner" as const },
  };

  type Auth = typeof ownerAuth | typeof staffAuth | typeof adminAuth | typeof outsiderAuth;

  function call(
    recurringInvoiceId: string,
    action: string,
    auth: Auth = ownerAuth,
  ) {
    return updateRecurringInvoiceHandler(
      fakeRequest({ recurringInvoiceId, action }, auth),
    );
  }

  async function template(id: string) {
    return (
      await testDb.doc(`tenants/${TENANT}/recurringInvoices/${id}`).get()
    ).data()!;
  }

  async function invoiceCount(): Promise<number> {
    return (await testDb.collection(`tenants/${TENANT}/invoices`).get()).size;
  }

  beforeEach(async () => {
    await clearFirestore();
    mockSesSend.mockClear();
  });

  it("rejects unauthenticated calls", async () => {
    await expect(
      updateRecurringInvoiceHandler(
        fakeRequest({ recurringInvoiceId: "r1", action: "pause" }, null),
      ),
    ).rejects.toThrow(/sign in required/i);
  });

  it("validates the id and the action", async () => {
    await seedTenant();
    const id = await seedRecurringTemplate();
    await expect(call(id, "delete")).rejects.toThrow(/action must be one of/);
    await expect(call("", "pause")).rejects.toThrow(/recurringInvoiceId required/);
    await expect(call(`${id}/x/y`, "pause")).rejects.toThrow(
      /recurringInvoiceId is invalid/,
    );
  });

  it("answers not-found for an unknown template or another tenant's", async () => {
    await seedTenant();
    const id = await seedRecurringTemplate();
    await expect(call("missing", "pause")).rejects.toThrow(/not found/i);
    await expect(call(id, "pause", outsiderAuth)).rejects.toThrow(/not found/i);
    expect((await template(id)).status).toBe("active");
  });

  it("pause: any role stops generation, and pausing again changes nothing", async () => {
    await seedTenant();
    const id = await seedRecurringTemplate(); // due: nextRunAt is in the past

    const res = await call(id, "pause", staffAuth);
    expect(res).toMatchObject({ recurringInvoiceId: id, status: "paused", changed: true });
    expect(res.nextRunAt).toBe("2026-04-01T00:00:00.000Z");

    const t = await template(id);
    expect(t.status).toBe("paused");
    expect(t.pausedAt).toBeTruthy();
    expect(t.updatedBy).toBe("u_staff");

    await processRecurringInvoicesHandler();
    expect(await invoiceCount()).toBe(0);

    await expect(call(id, "pause")).resolves.toMatchObject({
      status: "paused",
      changed: false,
    });
  });

  it("resume: reactivates on the next future slot and never backfills", async () => {
    await seedTenant();
    // Auto-paused after failures; monthly on the 1st, last slot 2026-04-01.
    const id = await seedRecurringTemplate({
      status: "paused",
      pausedAt: Timestamp.now(),
      consecutiveFailures: 3,
      lastRunStatus: "failed",
      lastRunError: "Auto-paused after 3 consecutive failures: boom",
    });

    const before = Date.now();
    const res = await call(id, "resume", staffAuth);
    expect(res).toMatchObject({ status: "active", changed: true });

    const t = await template(id);
    const next = (t.nextRunAt as Timestamp).toDate();
    expect(t.status).toBe("active");
    expect(t.pausedAt).toBeNull();
    expect(t.consecutiveFailures).toBe(0);
    expect(t.updatedBy).toBe("u_staff");
    expect(res.nextRunAt).toBe(next.toISOString());

    // Same anchor (1st, 00:00 UTC), strictly in the future, within one period.
    expect(next.getUTCDate()).toBe(1);
    expect(next.getUTCHours()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(before);
    expect(next.getTime() - before).toBeLessThanOrEqual(31 * 24 * 60 * 60 * 1000);

    // Nothing is due, so the processor makes no catch-up invoice.
    await processRecurringInvoicesHandler();
    expect(await invoiceCount()).toBe(0);
  });

  it("resume keeps a scheduled run that is still ahead", async () => {
    await seedTenant();
    const future = Timestamp.fromDate(new Date("2099-01-01T00:00:00Z"));
    const id = await seedRecurringTemplate({ status: "paused", nextRunAt: future });

    await call(id, "resume");
    expect((await template(id)).nextRunAt.isEqual(future)).toBe(true);
  });

  it("resume needs the recurringInvoices feature; pause and cancel don't", async () => {
    await seedTenant({ recurringFeature: false });
    const pausedId = await seedRecurringTemplate({ status: "paused" });
    const activeId = await seedRecurringTemplate();

    await expect(call(pausedId, "resume")).rejects.toThrow(/not enabled/i);
    expect((await template(pausedId)).status).toBe("paused");

    await expect(call(activeId, "pause")).resolves.toMatchObject({ status: "paused" });
    await expect(call(pausedId, "cancel")).resolves.toMatchObject({ status: "cancelled" });
  });

  it("resume completes a template whose invoice count was reached while paused", async () => {
    await seedTenant();
    const id = await seedRecurringTemplate({
      status: "paused",
      endAfterCount: 3,
      generatedCount: 3,
    });

    await expect(call(id, "resume")).resolves.toMatchObject({
      status: "completed",
      nextRunAt: null,
      changed: true,
    });
    expect((await template(id)).status).toBe("completed");
  });

  it("resume completes a template whose end date passed while paused", async () => {
    await seedTenant();
    const id = await seedRecurringTemplate({ status: "paused", endDate: "2026-04-15" });

    await expect(call(id, "resume")).resolves.toMatchObject({ status: "completed" });
    const t = await template(id);
    expect(t.status).toBe("completed");
    expect(t.pausedAt).toBeNull();
  });

  it("cancel: owner or admin only, and final", async () => {
    await seedTenant();
    const id = await seedRecurringTemplate();

    await expect(call(id, "cancel", staffAuth)).rejects.toThrow(/requires one of/i);
    expect((await template(id)).status).toBe("active");

    await expect(call(id, "cancel", adminAuth)).resolves.toMatchObject({
      status: "cancelled",
      nextRunAt: null,
      changed: true,
    });
    const t = await template(id);
    expect(t.cancelledAt).toBeTruthy();
    expect(t.updatedBy).toBe("u_admin");

    await expect(call(id, "cancel")).resolves.toMatchObject({ changed: false });
    await expect(call(id, "resume")).rejects.toThrow(/cannot resume/i);
    await expect(call(id, "pause")).rejects.toThrow(/cannot pause/i);

    await processRecurringInvoicesHandler();
    expect(await invoiceCount()).toBe(0);
  });

  it("a completed template can't be paused, resumed, or cancelled", async () => {
    await seedTenant();
    const id = await seedRecurringTemplate({ status: "completed" });
    await expect(call(id, "pause")).rejects.toThrow(/cannot pause/i);
    await expect(call(id, "resume")).rejects.toThrow(/cannot resume/i);
    await expect(call(id, "cancel")).rejects.toThrow(/cannot cancel/i);
    expect((await template(id)).status).toBe("completed");
  });
});
