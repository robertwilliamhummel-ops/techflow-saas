// onPaymentIncidentCreated (D5) — owner alerts for payment incidents written
// by the Stripe Connect webhook.

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

import { FieldValue } from "firebase-admin/firestore";
import { clearFirestore, testDb } from "./_setup";
import { handlePaymentIncidentCreated } from "../../src/stripe/onPaymentIncidentCreated";

const TENANT = "acme-plumbing";

async function seedTenant(): Promise<void> {
  const batch = testDb.batch();
  batch.set(testDb.doc(`tenants/${TENANT}/meta/settings`), {
    name: "Acme Plumbing",
  });
  const members: Array<[string, string, string, unknown]> = [
    ["u_owner", "owner", "owner@acme.test", null],
    ["u_coowner", "owner", "partner@acme.test", null],
    ["u_staff", "staff", "staff@acme.test", null],
    ["u_revoked", "owner", "former@acme.test", FieldValue.serverTimestamp()],
  ];
  for (const [uid, role, email, deletedAt] of members) {
    batch.set(testDb.doc(`userTenantMemberships/${uid}_${TENANT}`), {
      uid,
      tenantId: TENANT,
      role,
      invitedBy: null,
      deletedAt,
    });
    batch.set(testDb.doc(`users/${uid}`), { uid, email });
  }
  await batch.commit();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function recipients(): string[] {
  return mockSesSend.mock.calls.map(
    (call) => call[0].input.Destination.ToAddresses[0],
  );
}

beforeEach(async () => {
  await clearFirestore();
  mockSesSend.mockReset();
  mockSesSend.mockResolvedValue({ MessageId: "ses-msg-incident" });
  await seedTenant();
});

describe("handlePaymentIncidentCreated", () => {
  it("emails every active owner (not staff, not revoked) about a new dispute", async () => {
    const result = await handlePaymentIncidentCreated({
      tenantId: TENANT,
      invoiceId: "INV-0042",
      incidentId: "dispute-created_dp_1",
      incident: {
        kind: "dispute-created",
        disputeId: "dp_1",
        disputeReason: "fraudulent",
        evidenceDueBy: "2026-10-01",
      },
    });

    expect(result).toEqual({ sent: 2 });
    expect(recipients().sort()).toEqual(["owner@acme.test", "partner@acme.test"]);

    const req = mockSesSend.mock.calls[0][0].input;
    expect(req.Content.Simple.Subject.Data).toBe(
      "Chargeback opened on INV-0042 for Acme Plumbing",
    );
    expect(req.Content.Simple.Body.Text.Data).toContain("2026-10-01");
    expect(req.Content.Simple.Body.Text.Data).toContain("fraudulent");
    expect(req.FromEmailAddress).toBe(
      '"TechFlow" <notifications@techflowsolutions.ca>',
    );
    expect(req.EmailTags).toContainEqual({
      Name: "category",
      Value: "payment-incident",
    });
  });

  it("escapes Stripe-sourced text in the HTML body", async () => {
    await handlePaymentIncidentCreated({
      tenantId: TENANT,
      invoiceId: "INV-0042",
      incidentId: "dispute-created_dp_2",
      incident: {
        kind: "dispute-created",
        disputeReason: "<script>alert(1)</script>",
      },
    });
    const html = mockSesSend.mock.calls[0][0].input.Content.Simple.Body.Html.Data;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not email owners about non-notifiable incidents (tenant-mismatch)", async () => {
    const result = await handlePaymentIncidentCreated({
      tenantId: TENANT,
      invoiceId: "INV-0042",
      incidentId: "tenant-mismatch_cs_1",
      incident: { kind: "tenant-mismatch", reason: "tenant-mismatch" },
    });
    expect(result).toEqual({ sent: 0 });
    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it("never emails an owner twice for the same incident", async () => {
    const params = {
      tenantId: TENANT,
      invoiceId: "INV-0042",
      incidentId: "auto-refund_cs_9",
      incident: { kind: "auto-refund-version-mismatch", refundId: "re_1" },
    };
    await handlePaymentIncidentCreated(params);
    const again = await handlePaymentIncidentCreated(params);

    expect(again).toEqual({ sent: 0 });
    expect(mockSesSend).toHaveBeenCalledTimes(2); // two owners, once each
  });

  it("one owner's send failure does not block the other", async () => {
    mockSesSend.mockRejectedValueOnce(new Error("Throttling"));
    const result = await handlePaymentIncidentCreated({
      tenantId: TENANT,
      invoiceId: "INV-0042",
      incidentId: "dispute-lost_dp_3",
      incident: { kind: "dispute-lost", amountCents: 11300 },
    });
    expect(result).toEqual({ sent: 1 });
    expect(mockSesSend).toHaveBeenCalledTimes(2);
  });
});
