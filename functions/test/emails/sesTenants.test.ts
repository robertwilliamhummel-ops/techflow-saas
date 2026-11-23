// D22 — each business gets its own SES tenant: created at signup, by the
// backfill script, or by send.ts on a send that finds it missing. SES is
// mocked; Firestore and Auth run on the emulators for the onSignup cases.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sesSend, reportErrorMock } = vi.hoisted(() => ({
  sesSend: vi.fn(),
  reportErrorMock: vi.fn(),
}));

vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => `test-${name}` }),
  defineString: (_name: string, opts?: { default?: string }) => ({
    value: () => opts?.default ?? "",
  }),
}));

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Every command records its name and input; sesSend answers by name.
vi.mock("@aws-sdk/client-sesv2", () => {
  const command = (name: string) =>
    class {
      readonly commandName = name;
      readonly input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    };
  return {
    SESv2Client: vi.fn().mockImplementation(() => ({ send: sesSend })),
    SendEmailCommand: command("SendEmail"),
    CreateTenantCommand: command("CreateTenant"),
    CreateTenantResourceAssociationCommand: command("CreateTenantResourceAssociation"),
    PutTenantSuppressionAttributesCommand: command("PutTenantSuppressionAttributes"),
  };
});

vi.mock("../../src/shared/withSentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/withSentry")>()),
  reportError: reportErrorMock,
}));

import * as logger from "firebase-functions/logger";
import type { SESv2Client } from "@aws-sdk/client-sesv2";
import {
  clearAuthUsers,
  clearFirestore,
  createAuthUser,
  fakeRequest,
  testAuth,
} from "../callables/_setup";
import { ensureSesTenant } from "../../src/emails/sesTenants";
import { sendEmail, sesClient } from "../../src/emails/send";
import { onSignupHandler } from "../../src/tenants/onSignup";

type Sent = { commandName: string; input: Record<string, unknown> };
type Responder = (cmd: Sent) => unknown;

const IDENTITY_ARN = "arn:aws:ses:us-east-1:358982197909:identity/techflowsolutions.ca";
const CONFIG_SET = "techflow-staging-transactional";
const CONFIG_SET_ARN = `arn:aws:ses:us-east-1:358982197909:configuration-set/${CONFIG_SET}`;

function awsError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

// Answers by command name; a responder may throw to fail the call.
function answer(responders: Partial<Record<string, Responder>> = {}): void {
  sesSend.mockImplementation(async (cmd: Sent) => {
    const respond = responders[cmd.commandName];
    if (respond) return respond(cmd);
    return cmd.commandName === "SendEmail" ? { MessageId: "msg-1" } : {};
  });
}

function sent(name?: string): Sent[] {
  return sesSend.mock.calls
    .map(([cmd]) => cmd as Sent)
    .filter((cmd) => !name || cmd.commandName === name);
}

const client = { send: sesSend } as unknown as SESv2Client;

beforeEach(() => {
  sesSend.mockReset();
  reportErrorMock.mockReset();
  vi.mocked(logger.error).mockClear();
  process.env.SES_CONFIGURATION_SET = CONFIG_SET;
  delete process.env.SES_TENANTS_ENABLED;
  answer();
});

afterEach(() => {
  delete process.env.SES_CONFIGURATION_SET;
  delete process.env.SES_TENANTS_ENABLED;
});

describe("ensureSesTenant (D22)", () => {
  it("creates the tenant with its own suppression list, then associates the identity and configuration set", async () => {
    await ensureSesTenant("acme-plumbing", client);

    expect(sent().map((c) => [c.commandName, c.input])).toEqual([
      [
        "CreateTenant",
        {
          TenantName: "acme-plumbing",
          SuppressionAttributes: {
            SuppressionScope: "TENANT",
            SuppressedReasons: ["BOUNCE", "COMPLAINT"],
          },
        },
      ],
      ["CreateTenantResourceAssociation", { TenantName: "acme-plumbing", ResourceArn: IDENTITY_ARN }],
      ["CreateTenantResourceAssociation", { TenantName: "acme-plumbing", ResourceArn: CONFIG_SET_ARN }],
    ]);
  });

  it("is idempotent: an existing tenant gets its suppression settings again, existing associations are fine", async () => {
    answer({
      CreateTenant: () => {
        throw awsError("AlreadyExistsException");
      },
      CreateTenantResourceAssociation: () => {
        throw awsError("AlreadyExistsException");
      },
    });

    await expect(ensureSesTenant("acme-plumbing", client)).resolves.toBeUndefined();
    expect(sent("PutTenantSuppressionAttributes").map((c) => c.input)).toEqual([
      {
        TenantName: "acme-plumbing",
        SuppressionScope: "TENANT",
        SuppressedReasons: ["BOUNCE", "COMPLAINT"],
      },
    ]);
    expect(sent("CreateTenantResourceAssociation")).toHaveLength(2);
  });

  it("passes any other SES error on", async () => {
    answer({
      CreateTenant: () => {
        throw awsError("AccessDeniedException");
      },
    });
    await expect(ensureSesTenant("acme-plumbing", client)).rejects.toMatchObject({
      name: "AccessDeniedException",
    });
    expect(sent("CreateTenantResourceAssociation")).toHaveLength(0);
  });

  it("without a configuration set, associates the identity only and logs an error", async () => {
    delete process.env.SES_CONFIGURATION_SET;
    await ensureSesTenant("acme-plumbing", client);
    expect(sent("CreateTenantResourceAssociation").map((c) => c.input.ResourceArn)).toEqual([
      IDENTITY_ARN,
    ]);
    expect(logger.error).toHaveBeenCalled();
  });

  it("follows SES_REGION and the From address's domain", async () => {
    process.env.SES_REGION = "ca-central-1";
    process.env.EMAIL_FROM_ADDRESS = "billing@Example.CA";
    try {
      await ensureSesTenant("acme-plumbing", client);
      expect(sent("CreateTenantResourceAssociation").map((c) => c.input.ResourceArn)).toEqual([
        "arn:aws:ses:ca-central-1:358982197909:identity/example.ca",
        `arn:aws:ses:ca-central-1:358982197909:configuration-set/${CONFIG_SET}`,
      ]);
    } finally {
      delete process.env.SES_REGION;
      delete process.env.EMAIL_FROM_ADDRESS;
    }
  });
});

describe("sendEmail sends as the business's SES tenant (D22)", () => {
  const email = {
    to: "jane@example.com",
    subject: "Invoice INV-0001",
    html: "<p>Hi</p>",
    text: "Hi",
    fromName: "Acme Plumbing",
    category: "invoice" as const,
    tenantId: "acme-plumbing",
    documentId: "INV-0001",
  };

  it("with the switch off, sends without TenantName and touches no tenant", async () => {
    await sendEmail(email);
    expect(sent().map((c) => c.commandName)).toEqual(["SendEmail"]);
    expect(sent("SendEmail")[0].input.TenantName).toBeUndefined();
  });

  it("with the switch on, sends as the tenant", async () => {
    process.env.SES_TENANTS_ENABLED = "true";
    await expect(sendEmail(email)).resolves.toEqual({ messageId: "msg-1", deduplicated: false });
    expect(sent().map((c) => c.commandName)).toEqual(["SendEmail"]);
    expect(sent("SendEmail")[0].input.TenantName).toBe("acme-plumbing");
  });

  it("an email with no business sends without TenantName", async () => {
    process.env.SES_TENANTS_ENABLED = "true";
    await sendEmail({ ...email, category: "portal-sign-in", tenantId: null, documentId: null });
    expect(sent("SendEmail")[0].input.TenantName).toBeUndefined();
  });

  it("a missing tenant is created once and the send retried as the tenant", async () => {
    process.env.SES_TENANTS_ENABLED = "true";
    let sends = 0;
    answer({
      SendEmail: () => {
        sends += 1;
        if (sends === 1) throw awsError("NotFoundException", "Tenant acme-plumbing not found");
        return { MessageId: "msg-2" };
      },
    });

    await expect(sendEmail(email)).resolves.toEqual({ messageId: "msg-2", deduplicated: false });
    expect(sent().map((c) => c.commandName)).toEqual([
      "SendEmail",
      "CreateTenant",
      "CreateTenantResourceAssociation",
      "CreateTenantResourceAssociation",
      "SendEmail",
    ]);
    expect(sent("SendEmail").map((c) => c.input.TenantName)).toEqual([
      "acme-plumbing",
      "acme-plumbing",
    ]);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it("if the tenant can't be created, the email still goes out without TenantName, and that's reported", async () => {
    process.env.SES_TENANTS_ENABLED = "true";
    let sends = 0;
    answer({
      SendEmail: () => {
        sends += 1;
        if (sends === 1) throw awsError("NotFoundException");
        return { MessageId: "msg-3" };
      },
      CreateTenant: () => {
        throw awsError("AccessDeniedException");
      },
    });

    await expect(sendEmail(email)).resolves.toEqual({ messageId: "msg-3", deduplicated: false });
    expect(sent("SendEmail").map((c) => c.input.TenantName)).toEqual(["acme-plumbing", undefined]);
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "AccessDeniedException" }),
      expect.objectContaining({ functionName: "sendEmail", tenantId: "acme-plumbing" }),
    );
  });

  it("if the retry as the tenant still fails, sends without TenantName (one email in all)", async () => {
    process.env.SES_TENANTS_ENABLED = "true";
    answer({
      SendEmail: (cmd) => {
        if (cmd.input.TenantName) {
          throw awsError("BadRequestException", "Configuration set is not associated with tenant");
        }
        return { MessageId: "msg-4" };
      },
    });

    await expect(sendEmail(email)).resolves.toEqual({ messageId: "msg-4", deduplicated: false });
    expect(sent("SendEmail").map((c) => c.input.TenantName)).toEqual([
      "acme-plumbing",
      "acme-plumbing",
      undefined,
    ]);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
  });

  it("an error that isn't about the tenant fails the send as before", async () => {
    process.env.SES_TENANTS_ENABLED = "true";
    answer({
      SendEmail: () => {
        throw awsError("MessageRejected", "Email address is not verified");
      },
    });
    await expect(sendEmail(email)).rejects.toMatchObject({ name: "MessageRejected" });
    expect(sent().map((c) => c.commandName)).toEqual(["SendEmail"]);
  });
});

describe("onSignup creates the business's SES tenant (D22)", () => {
  const OWNER = { uid: "u_ses_owner", email: "owner@ses.test" };

  beforeEach(async () => {
    await clearFirestore();
    await clearAuthUsers();
    await createAuthUser({ uid: OWNER.uid, email: OWNER.email, emailVerified: true });
  });

  function signup() {
    return onSignupHandler(
      fakeRequest(
        { businessName: "Ses Plumbing" },
        { uid: OWNER.uid, claims: { email: OWNER.email } },
      ),
    );
  }

  it("with the switch on, the new business gets its tenant", async () => {
    process.env.SES_TENANTS_ENABLED = "true";
    const { tenantId } = await signup();
    expect(sent("CreateTenant").map((c) => c.input.TenantName)).toEqual([tenantId]);
    expect(sent("CreateTenantResourceAssociation").map((c) => c.input.ResourceArn)).toEqual([
      IDENTITY_ARN,
      CONFIG_SET_ARN,
    ]);
  });

  it("a failure doesn't fail signup; it's reported", async () => {
    process.env.SES_TENANTS_ENABLED = "true";
    answer({
      CreateTenant: () => {
        throw awsError("ThrottlingException");
      },
    });
    const { tenantId } = await signup();
    expect(tenantId).toBe("ses-plumbing");
    expect((await testAuth.getUser(OWNER.uid)).customClaims).toMatchObject({
      tenantId,
      role: "owner",
    });
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ThrottlingException" }),
      expect.objectContaining({ functionName: "onSignup", tenantId }),
    );
  });

  it("with the switch off, signup makes no SES calls", async () => {
    await signup();
    expect(sesSend).not.toHaveBeenCalled();
  });

  it("uses the functions' SES client", () => {
    expect(sesClient()).toMatchObject({ send: sesSend });
  });
});
