import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock Resend SDK — intercept all sends and capture arguments.
// ---------------------------------------------------------------------------
const mockSend = vi.fn().mockResolvedValue({ data: { id: "re_mock123" } });

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}));

// Mock defineSecret so it returns a dummy value (tests never hit real Resend).
vi.mock("firebase-functions/params", () => ({
  defineSecret: () => ({ value: () => "re_test_key" }),
  defineString: () => ({ value: () => "http://localhost:3000" }),
}));

// Mock firebase-functions/logger to suppress logs during tests.
vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  error: vi.fn(),
}));

import { sendInvitationEmail, type InvitationEmailParams } from "../../src/emails/send";

function baseParams(
  overrides: Partial<InvitationEmailParams> = {},
): InvitationEmailParams {
  return {
    to: "newstaff@example.com",
    tenant: {
      name: "Acme Plumbing",
      address: "123 Main St",
      logoUrl: null,
      emailFooter: "Licensed & insured",
      primaryColor: "#0066CC",
    },
    inviterName: "Jane Owner",
    role: "staff",
    acceptUrl: "https://app.techflowsolutions.ca/accept-invite?t=abc",
    ...overrides,
  };
}

describe("sendInvitationEmail", () => {
  beforeEach(() => {
    mockSend.mockClear();
  });

  it("sends HTML + plain-text email via Resend", async () => {
    await sendInvitationEmail(baseParams());

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [payload] = mockSend.mock.calls[0];

    expect(payload.to).toBe("newstaff@example.com");
    expect(payload.subject).toContain("Jane Owner");
    expect(payload.subject).toContain("Acme Plumbing");
    expect(payload.html).toContain("Accept Invitation");
    expect(typeof payload.text).toBe("string");
    expect(payload.text.length).toBeGreaterThan(0);
  });

  it("uses From with tenant name on platform domain", async () => {
    await sendInvitationEmail(baseParams());

    const [payload] = mockSend.mock.calls[0];
    expect(payload.from).toMatch(
      /^Acme Plumbing <notifications@techflowsolutions\.ca>$/,
    );
  });

  it("sets replyTo when valid email is provided", async () => {
    await sendInvitationEmail(
      baseParams({ replyTo: "jane@acmeplumbing.ca" }),
    );

    const [payload] = mockSend.mock.calls[0];
    expect(payload.replyTo).toBe("jane@acmeplumbing.ca");
  });

  it("strips CRLF from replyTo (header injection defense)", async () => {
    await sendInvitationEmail(
      baseParams({ replyTo: "jane@acme.ca\r\nBcc: evil@x.com" }),
    );

    const [payload] = mockSend.mock.calls[0];
    // After sanitization the replyTo is "jane@acme.ca Bcc: evil@x.com"
    // which fails email validation → replyTo should be omitted.
    expect(payload.replyTo).toBeUndefined();
  });

  it("omits replyTo when input is not a valid email", async () => {
    await sendInvitationEmail(baseParams({ replyTo: "not-an-email" }));

    const [payload] = mockSend.mock.calls[0];
    expect(payload.replyTo).toBeUndefined();
  });

  it("passes idempotencyKey as Resend header", async () => {
    await sendInvitationEmail(
      baseParams({ idempotencyKey: "invite_abc123" }),
    );

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [, options] = mockSend.mock.calls[0];
    // The headers object should contain the idempotency key.
    expect(options?.headers?.["Idempotency-Key"]).toBe("invite_abc123");
  });

  it("falls back to 'Your team' in subject when inviterName is null", async () => {
    await sendInvitationEmail(baseParams({ inviterName: null }));

    const [payload] = mockSend.mock.calls[0];
    expect(payload.subject).toMatch(/^Your team invited you to/);
  });

  it("falls back to 'TechFlow' in subject when tenant name is empty", async () => {
    await sendInvitationEmail(
      baseParams({
        tenant: { ...baseParams().tenant, name: "" },
      }),
    );

    const [payload] = mockSend.mock.calls[0];
    expect(payload.subject).toContain("TechFlow");
    expect(payload.from).toMatch(/^TechFlow </);
  });

  it("sanitizes tenant name in From header (no CRLF)", async () => {
    await sendInvitationEmail(
      baseParams({
        tenant: {
          ...baseParams().tenant,
          name: "Acme\r\nBcc: evil@x",
        },
      }),
    );

    const [payload] = mockSend.mock.calls[0];
    expect(payload.from).not.toContain("\r");
    expect(payload.from).not.toContain("\n");
    expect(payload.from).toContain("Acme Bcc: evil@x");
  });

  it("throws when Resend SDK fails", async () => {
    mockSend.mockRejectedValueOnce(new Error("rate_limited"));

    await expect(sendInvitationEmail(baseParams())).rejects.toThrow(
      "rate_limited",
    );
  });
});
