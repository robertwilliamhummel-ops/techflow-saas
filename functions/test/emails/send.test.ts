// Amazon SES transport (D5). Runs against the Firestore emulator because the
// idempotency sentinel lives in emailSends/{hash}.

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
  defineString: () => ({ value: () => "http://localhost:3000" }),
}));

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { clearFirestore, testDb } from "../callables/_setup";
import {
  formatFromHeader,
  pickReplyTo,
  sendEmail,
  sendInvitationEmail,
  type SendEmailInput,
} from "../../src/emails/send";

function input(overrides: Partial<SendEmailInput> = {}): SendEmailInput {
  return {
    to: "Jane@Example.com",
    subject: "Invoice INV-0001 from Acme Plumbing",
    html: "<p>Hi Jane</p>",
    text: "Hi Jane",
    fromName: "Acme Plumbing",
    category: "invoice",
    tenantId: "acme-plumbing",
    documentId: "INV-0001",
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lastRequest(): any {
  return mockSesSend.mock.calls.at(-1)?.[0].input;
}

function sentinelPath(key: string): string {
  return `emailSends/${createHash("sha256").update(key).digest("hex")}`;
}

beforeEach(async () => {
  await clearFirestore();
  mockSesSend.mockReset();
  mockSesSend.mockResolvedValue({ MessageId: "ses-msg-1" });
  delete process.env.SES_CONFIGURATION_SET;
  delete process.env.SES_TENANTS_ENABLED;
  delete process.env.EMAIL_FROM_ADDRESS;
});

describe("sendEmail", () => {
  it("sends HTML + text as UTF-8 to the lowercased recipient", async () => {
    const result = await sendEmail(input());

    expect(result).toEqual({ messageId: "ses-msg-1", deduplicated: false });
    const req = lastRequest();
    expect(req.Destination.ToAddresses).toEqual(["jane@example.com"]);
    expect(req.Content.Simple.Subject).toEqual({
      Data: "Invoice INV-0001 from Acme Plumbing",
      Charset: "UTF-8",
    });
    expect(req.Content.Simple.Body.Html).toEqual({
      Data: "<p>Hi Jane</p>",
      Charset: "UTF-8",
    });
    expect(req.Content.Simple.Body.Text).toEqual({
      Data: "Hi Jane",
      Charset: "UTF-8",
    });
  });

  it("sends From the tenant name on the platform address; EMAIL_FROM_ADDRESS overrides", async () => {
    await sendEmail(input());
    expect(lastRequest().FromEmailAddress).toBe(
      '"Acme Plumbing" <notifications@techflowsolutions.ca>',
    );

    process.env.EMAIL_FROM_ADDRESS = "billing@techflowsolutions.ca";
    await sendEmail(input());
    expect(lastRequest().FromEmailAddress).toBe(
      '"Acme Plumbing" <billing@techflowsolutions.ca>',
    );
  });

  it("strips CR/LF from the From display name (header injection)", async () => {
    await sendEmail(input({ fromName: "Acme\r\nBcc: evil@x.com" }));
    const from = lastRequest().FromEmailAddress as string;
    expect(from).not.toMatch(/[\r\n]/);
    expect(from).toBe('"Acme Bcc: evil@x.com" <notifications@techflowsolutions.ca>');
  });

  it("stamps category, tenantId, and documentId tags for bounce tracking", async () => {
    await sendEmail(input({ documentId: "INV 0001/x" }));
    expect(lastRequest().EmailTags).toEqual([
      { Name: "category", Value: "invoice" },
      { Name: "tenantId", Value: "acme-plumbing" },
      { Name: "documentId", Value: "INV_0001_x" },
    ]);
  });

  it("uses SES_CONFIGURATION_SET, and TenantName only when SES tenants are enabled", async () => {
    await sendEmail(input());
    expect(lastRequest().ConfigurationSetName).toBeUndefined();
    expect(lastRequest().TenantName).toBeUndefined();

    process.env.SES_CONFIGURATION_SET = "techflow-transactional";
    process.env.SES_TENANTS_ENABLED = "true";
    await sendEmail(input());
    expect(lastRequest().ConfigurationSetName).toBe("techflow-transactional");
    expect(lastRequest().TenantName).toBe("acme-plumbing");
  });

  it("rejects an invalid recipient without calling SES", async () => {
    await expect(sendEmail(input({ to: "not-an-email" }))).rejects.toThrow(
      /Invalid recipient/,
    );
    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it("propagates SES failures", async () => {
    mockSesSend.mockRejectedValueOnce(new Error("Throttling"));
    await expect(sendEmail(input())).rejects.toThrow("Throttling");
  });

  it("idempotencyKey: a repeat send is deduplicated and the sentinel records the message", async () => {
    const first = await sendEmail(input({ idempotencyKey: "recurring:INV-0001" }));
    const second = await sendEmail(input({ idempotencyKey: "recurring:INV-0001" }));

    expect(first.deduplicated).toBe(false);
    expect(second).toEqual({ messageId: null, deduplicated: true });
    expect(mockSesSend).toHaveBeenCalledTimes(1);

    const sentinel = await testDb.doc(sentinelPath("recurring:INV-0001")).get();
    expect(sentinel.data()?.status).toBe("sent");
    expect(sentinel.data()?.messageId).toBe("ses-msg-1");
    expect(sentinel.data()?.expireAt).toBeDefined();
  });

  it("idempotencyKey: a failed send releases the claim so a retry goes out", async () => {
    mockSesSend.mockRejectedValueOnce(new Error("Throttling"));
    await expect(
      sendEmail(input({ idempotencyKey: "incident:x" })),
    ).rejects.toThrow("Throttling");

    const retry = await sendEmail(input({ idempotencyKey: "incident:x" }));
    expect(retry.deduplicated).toBe(false);
    expect(mockSesSend).toHaveBeenCalledTimes(2);
  });
});

describe("header helpers", () => {
  it("formatFromHeader escapes quotes/backslashes and RFC 2047-encodes non-ASCII names", () => {
    expect(formatFromHeader('Bob "The" \\Plumber', "n@t.ca")).toBe(
      '"Bob \\"The\\" \\\\Plumber" <n@t.ca>',
    );
    const encoded = formatFromHeader("Plomberie Côté", "n@t.ca");
    const match = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?= <n@t\.ca>$/.exec(encoded);
    expect(match).not.toBeNull();
    expect(Buffer.from(match![1], "base64").toString("utf8")).toBe(
      "Plomberie Côté",
    );
  });

  it("formatFromHeader falls back to TechFlow for an empty name", () => {
    expect(formatFromHeader("", "n@t.ca")).toBe('"TechFlow" <n@t.ca>');
  });

  it("pickReplyTo returns the first valid candidate, lowercased", () => {
    expect(pickReplyTo(null, "not-an-email", "Office@Acme.ca")).toBe(
      "office@acme.ca",
    );
  });

  it("pickReplyTo rejects CRLF-smuggled addresses", () => {
    expect(pickReplyTo("jane@acme.ca\r\nBcc: evil@x.com")).toBeUndefined();
  });
});

describe("sendInvitationEmail", () => {
  const params = {
    to: "newstaff@example.com",
    tenant: {
      name: "Acme Plumbing",
      address: "123 Main St",
      logoUrl: null,
      emailFooter: "Licensed & insured",
      primaryColor: "#0066CC",
    },
    inviterName: "Jane Owner",
    role: "staff" as const,
    acceptUrl: "https://portal.techflowsolutions.ca/accept-invite?t=abc",
    tenantId: "acme-plumbing",
  };

  it("renders StaffInvite and sends as a staff-invite", async () => {
    await sendInvitationEmail(params);
    const req = lastRequest();
    expect(req.Content.Simple.Subject.Data).toBe(
      "Jane Owner invited you to Acme Plumbing",
    );
    expect(req.Content.Simple.Body.Html.Data).toContain("Accept Invitation");
    expect(req.Content.Simple.Body.Text.Data.length).toBeGreaterThan(0);
    expect(req.EmailTags).toContainEqual({
      Name: "category",
      Value: "staff-invite",
    });
  });

  it("falls back to 'Your team' when inviterName is null", async () => {
    await sendInvitationEmail({ ...params, inviterName: null });
    expect(lastRequest().Content.Simple.Subject.Data).toMatch(
      /^Your team invited you to/,
    );
  });

  it("sends once per invitation idempotency key", async () => {
    await sendInvitationEmail({ ...params, idempotencyKey: "invitation:a:1" });
    await sendInvitationEmail({ ...params, idempotencyKey: "invitation:a:1" });
    expect(mockSesSend).toHaveBeenCalledTimes(1);
  });
});
