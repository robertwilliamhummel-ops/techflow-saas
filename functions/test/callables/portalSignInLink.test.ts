// E-01 — sendPortalSignInLink: branded portal sign-in links, sent only to
// customers, only to portal URLs, and rate limited per address.

import { createHash } from "node:crypto";
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

const mockLoggerError = vi.fn();
vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: (...args: unknown[]) => mockLoggerError(...args),
}));

import { Timestamp } from "firebase-admin/firestore";
import { clearAuthUsers, clearFirestore, fakeRequest, testDb } from "./_setup";
import { sendPortalSignInLinkHandler } from "../../src/portal/sendPortalSignInLink";

const TENANT = "acme-plumbing";
const DOMAIN = "invoices.acme.test";
const CUSTOMER = "jane@example.com";

function call(email: string, continueUrl: string) {
  return sendPortalSignInLinkHandler(fakeRequest({ email, continueUrl }, null));
}

function limitRef(email: string) {
  const key = createHash("sha256").update(email).digest("hex");
  return testDb.doc(`signInLinkLimits/${key}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sentEmails(): any[] {
  return mockSesSend.mock.calls.map((c) => c[0].input);
}

async function seedDocument(
  collection: "invoices" | "quotes",
  id: string,
  email: string,
  status: string,
): Promise<void> {
  await testDb.doc(`tenants/${TENANT}/${collection}/${id}`).set({
    customer: { name: "Jane Doe", email, phone: null },
    totals: { subtotal: 100, taxAmount: 13, total: 113 },
    tenantSnapshot: { name: "Acme Plumbing", primaryColor: "#0066CC" },
    status,
    createdAt: Timestamp.now(),
  });
}

beforeEach(async () => {
  await clearFirestore();
  await clearAuthUsers();
  mockSesSend.mockReset();
  mockSesSend.mockResolvedValue({ MessageId: "ses-sign-in" });
  mockLoggerError.mockReset();

  const batch = testDb.batch();
  batch.set(testDb.doc(`tenants/${TENANT}/meta/settings`), {
    name: "Acme Plumbing",
    primaryColor: "#0066CC",
    address: "123 Main St",
    emailFooter: null,
    contactEmail: "office@acme.test",
    etransferEmail: "pay@acme.test",
    customDomain: DOMAIN,
    customDomainStatus: { stage: "verified", message: null },
  });
  batch.set(testDb.doc(`customDomains/${DOMAIN}`), { tenantId: TENANT });
  // A second tenant whose domain is still waiting on DNS.
  batch.set(testDb.doc("tenants/bright-electric/meta/settings"), {
    name: "Bright Electric",
    customDomain: "billing.bright.test",
    customDomainStatus: { stage: "dns_pending", message: null },
  });
  batch.set(testDb.doc("customDomains/billing.bright.test"), {
    tenantId: "bright-electric",
  });
  await batch.commit();
  await seedDocument("invoices", "INV-0001", CUSTOMER, "sent");
});

describe("sendPortalSignInLink (E-01)", () => {
  it("emails a branded sign-in link on the business's verified domain", async () => {
    const continueUrl = `https://${DOMAIN}/portal/invoices/INV-0001?tenantId=${TENANT}`;

    await expect(call("Jane@Example.com", continueUrl)).resolves.toEqual({ ok: true });

    expect(sentEmails()).toHaveLength(1);
    const req = sentEmails()[0];
    expect(req.Destination.ToAddresses).toEqual([CUSTOMER]);
    expect(req.Content.Simple.Subject.Data).toBe("Sign in to Acme Plumbing");
    expect(req.FromEmailAddress).toBe(
      '"Acme Plumbing" <notifications@techflowsolutions.ca>',
    );
    expect(req.ReplyToAddresses).toEqual(["office@acme.test"]);
    expect(req.EmailTags).toEqual(
      expect.arrayContaining([
        { Name: "category", Value: "portal-sign-in" },
        { Name: "tenantId", Value: TENANT },
      ]),
    );

    const text = req.Content.Simple.Body.Text.Data as string;
    expect(text).toContain("mode=signIn");
    expect(text).toContain("oobCode=");
    expect(text).toContain(`continueUrl=${encodeURIComponent(continueUrl)}`);
  });

  it("uses the platform name on the shared portal host", async () => {
    await call(CUSTOMER, "https://portal.techflowsolutions.ca/portal");

    const req = sentEmails()[0];
    expect(req.Content.Simple.Subject.Data).toBe("Sign in to TechFlow");
    expect(req.FromEmailAddress).toBe('"TechFlow" <notifications@techflowsolutions.ca>');
    expect(req.ReplyToAddresses).toBeUndefined();
    expect(req.EmailTags).not.toContainEqual(
      expect.objectContaining({ Name: "tenantId" }),
    );
  });

  it("sends a link to a customer who only has a quote", async () => {
    await seedDocument("quotes", "QT-0001", "bob@example.com", "sent");
    await call("bob@example.com", "https://portal.techflowsolutions.ca/portal");
    expect(sentEmails()).toHaveLength(1);
  });

  it("answers ok but sends nothing to an address without visible invoices or quotes", async () => {
    await seedDocument("invoices", "INV-0002", "drafty@example.com", "draft");

    await expect(
      call("stranger@example.com", "https://portal.techflowsolutions.ca/portal"),
    ).resolves.toEqual({ ok: true });
    await expect(
      call("drafty@example.com", "https://portal.techflowsolutions.ca/portal"),
    ).resolves.toEqual({ ok: true });

    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it("allows one link a minute per address, still answering ok", async () => {
    const url = "https://portal.techflowsolutions.ca/portal";
    await call(CUSTOMER, url);
    await expect(call(CUSTOMER, url)).resolves.toEqual({ ok: true });
    expect(mockSesSend).toHaveBeenCalledTimes(1);

    const counter = (await limitRef(CUSTOMER).get()).data()!;
    expect(counter.count).toBe(1);
    expect(counter.expireAt).toBeInstanceOf(Timestamp);
  });

  it("allows five links an hour per address, then a new window starts", async () => {
    const url = "https://portal.techflowsolutions.ca/portal";
    const now = Date.now();
    await limitRef(CUSTOMER).set({
      windowStartedAt: Timestamp.fromMillis(now - 10 * 60 * 1000),
      count: 5,
      lastAt: Timestamp.fromMillis(now - 5 * 60 * 1000),
    });
    await call(CUSTOMER, url);
    expect(mockSesSend).not.toHaveBeenCalled();

    await limitRef(CUSTOMER).update({
      windowStartedAt: Timestamp.fromMillis(now - 2 * 60 * 60 * 1000),
    });
    await call(CUSTOMER, url);
    expect(mockSesSend).toHaveBeenCalledTimes(1);
    expect((await limitRef(CUSTOMER).get()).data()!.count).toBe(1);
  });

  it.each([
    ["another site", "https://evil.example.com/portal"],
    ["an unverified custom domain", "https://billing.bright.test/portal"],
    ["a non-portal page", "https://portal.techflowsolutions.ca/dashboard"],
    ["a lookalike path", "https://portal.techflowsolutions.ca/portalx"],
    ["plain http on a custom domain", `http://${DOMAIN}/portal`],
    ["a custom domain with a port", `https://${DOMAIN}:8443/portal`],
    ["embedded credentials", "https://user:pw@portal.techflowsolutions.ca/portal"],
    ["a javascript URL", "javascript:alert(1)"],
    ["not a URL", "portal"],
  ])("rejects a continue URL on %s", async (_label, continueUrl) => {
    await expect(call(CUSTOMER, continueUrl)).rejects.toThrow(
      /continueUrl must be a customer portal page/,
    );
    expect(mockSesSend).not.toHaveBeenCalled();
    expect((await limitRef(CUSTOMER).get()).exists).toBe(false);
  });

  it("rejects an invalid email address", async () => {
    await expect(
      call("not-an-email", "https://portal.techflowsolutions.ca/portal"),
    ).rejects.toThrow(/valid email/);
  });

  it("still answers ok when the email can't be sent, and logs it", async () => {
    mockSesSend.mockRejectedValueOnce(new Error("Throttling"));
    await expect(
      call(CUSTOMER, "https://portal.techflowsolutions.ca/portal"),
    ).resolves.toEqual({ ok: true });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "portalSignInLink: link or send failed",
      expect.objectContaining({ error: expect.stringContaining("Throttling") }),
    );
  });
});
