// R-04 — per-user rate limits on email sends, PDF previews, and invitations.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("firebase-functions/params", () => ({
  defineSecret: () => ({ value: () => "test-secret" }),
  defineString: (_name: string, opts?: { default?: string }) => ({
    value: () => opts?.default ?? "",
  }),
}));

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockSesSend = vi.fn();
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: vi.fn().mockImplementation(() => ({ send: mockSesSend })),
  SendEmailCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ input })),
}));

import { Timestamp } from "firebase-admin/firestore";
import { clearFirestore, fakeRequest, testDb } from "./_setup";
import {
  RATE_LIMITS,
  enforceRateLimit,
  type RateLimit,
} from "../../src/shared/rateLimit";
import { sendInvoiceEmailHandler } from "../../src/invoices/sendInvoiceEmail";
import { sendQuoteEmailHandler } from "../../src/quotes/sendQuoteEmail";
import { previewInvoicePDFHandler } from "../../src/invoices/previewInvoicePDF";
import { previewQuotePDFHandler } from "../../src/quotes/previewQuotePDF";
import { createInvitationHandler } from "../../src/tenants/createInvitation";

const TENANT = "acme-plumbing";
const HOUR_MS = 60 * 60 * 1000;
const owner = {
  uid: "u_owner",
  claims: { email: "owner@acme.test", tenantId: TENANT, role: "owner" as const },
};

function counterRef(uid: string, action: string) {
  return testDb.doc(`rateLimits/${uid}_${action}`);
}

async function exhaust(uid: string, limit: RateLimit): Promise<void> {
  await counterRef(uid, limit.action).set({
    uid,
    action: limit.action,
    windowStartedAt: Timestamp.fromMillis(Date.now() - 10 * 60 * 1000),
    count: limit.max,
  });
}

beforeEach(async () => {
  await clearFirestore();
  mockSesSend.mockReset();
});

describe("enforceRateLimit (R-04)", () => {
  const limit: RateLimit = { action: "test-action", max: 3, windowMs: HOUR_MS };

  it("allows calls up to the limit, then refuses them", async () => {
    for (let i = 0; i < 3; i++) await enforceRateLimit("u1", limit);
    await expect(enforceRateLimit("u1", limit)).rejects.toThrow(
      /^Too many requests\. Try again in \d+ minutes?\.$/,
    );

    const counter = (await counterRef("u1", "test-action").get()).data()!;
    expect(counter.count).toBe(3);
    expect(counter.expireAt.toMillis()).toBeGreaterThan(
      counter.windowStartedAt.toMillis() + limit.windowMs,
    );
  });

  it("says how long until the window resets", async () => {
    await counterRef("u1", "test-action").set({
      windowStartedAt: Timestamp.fromMillis(Date.now() - 50 * 60 * 1000),
      count: 3,
    });
    await expect(enforceRateLimit("u1", limit)).rejects.toThrow(
      "Too many requests. Try again in 10 minutes.",
    );
  });

  it("starts a new window once the old one has passed", async () => {
    await counterRef("u1", "test-action").set({
      windowStartedAt: Timestamp.fromMillis(Date.now() - 2 * HOUR_MS),
      count: 3,
    });
    await expect(enforceRateLimit("u1", limit)).resolves.toBeUndefined();
    expect((await counterRef("u1", "test-action").get()).data()!.count).toBe(1);
  });

  it("counts each user and each action separately", async () => {
    await exhaust("u1", limit);
    await expect(enforceRateLimit("u2", limit)).resolves.toBeUndefined();
    await expect(
      enforceRateLimit("u1", { ...limit, action: "other-action" }),
    ).resolves.toBeUndefined();
  });

  it("uses the documented limits", () => {
    expect(RATE_LIMITS).toEqual({
      sendEmail: { action: "send-email", max: 50, windowMs: HOUR_MS },
      pdfPreview: { action: "pdf-preview", max: 60, windowMs: HOUR_MS },
      invitation: { action: "invitation", max: 20, windowMs: HOUR_MS },
    });
  });
});

describe("callables check their limit before doing any work (R-04)", () => {
  it.each([
    [
      "sendInvoiceEmail",
      RATE_LIMITS.sendEmail,
      () => sendInvoiceEmailHandler(fakeRequest({ invoiceId: "INV-9999" }, owner)),
      /Invoice not found/,
    ],
    [
      "sendQuoteEmail",
      RATE_LIMITS.sendEmail,
      () => sendQuoteEmailHandler(fakeRequest({ quoteId: "QT-9999" }, owner)),
      /Quote not found/,
    ],
    [
      "previewInvoicePDF",
      RATE_LIMITS.pdfPreview,
      () => previewInvoicePDFHandler(fakeRequest({ invoiceId: "INV-9999" }, owner)),
      /Invoice not found/,
    ],
    [
      "previewQuotePDF",
      RATE_LIMITS.pdfPreview,
      () => previewQuotePDFHandler(fakeRequest({ quoteId: "QT-9999" }, owner)),
      /Quote not found/,
    ],
  ])("%s", async (_name, limit, invoke, errorUnderLimit) => {
    // Under the limit the call reaches the document lookup.
    await expect(invoke()).rejects.toThrow(errorUnderLimit);

    await exhaust("u_owner", limit);
    await expect(invoke()).rejects.toThrow(/Too many requests/);
  });

  it("invoice and quote emails share one budget", async () => {
    await exhaust("u_owner", RATE_LIMITS.sendEmail);
    await expect(
      sendQuoteEmailHandler(fakeRequest({ quoteId: "QT-9999" }, owner)),
    ).rejects.toThrow(/Too many requests/);
  });

  it("createInvitation creates and emails nothing once the limit is reached", async () => {
    await exhaust("u_owner", RATE_LIMITS.invitation);

    await expect(
      createInvitationHandler(
        fakeRequest({ email: "new.hire@acme.test", role: "staff" }, owner),
      ),
    ).rejects.toThrow(/Too many requests/);

    expect(
      (await testDb.collection(`tenants/${TENANT}/invitations`).get()).size,
    ).toBe(0);
    expect(mockSesSend).not.toHaveBeenCalled();
  });
});
