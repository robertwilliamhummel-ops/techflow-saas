// F-02 — a verified email is required on the server too. The dashboard sends an
// owner whose email isn't verified to /verify-email, but that was the only gate:
// through the callables an unverified account could still create and send
// invoices, invite staff, and start Stripe onboarding. requireTenant now refuses
// a token without email_verified: true, so every tenant callable does. The
// callables that don't act for a business are listed below with what they check
// instead, so a new callable has to be one or the other.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { sesSend } = vi.hoisted(() => ({ sesSend: vi.fn() }));

vi.mock("firebase-functions/params", () => ({
  defineSecret: () => ({ value: () => "test-secret-value-at-least-32-chars!!" }),
  defineString: (_name: string, opts?: { default?: string }) => ({
    value: () => opts?.default ?? "",
  }),
}));

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: vi.fn().mockImplementation(() => ({ send: sesSend })),
  SendEmailCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

import type { CallableRequest } from "firebase-functions/v2/https";
import type Stripe from "stripe";
import {
  clearAuthUsers,
  clearFirestore,
  createAuthUser,
  fakeRequest,
  testAuth,
  testDb,
} from "./_setup";
import * as deployedModule from "../../src/index";
import { VERIFY_EMAIL_MESSAGE } from "../../src/shared/auth";
import { __setStripeClientForTest } from "../../src/shared/stripe";

interface DeployedCallable {
  run(request: CallableRequest<unknown>): Promise<unknown>;
}

// Callables that don't act for a business, and what each checks instead.
const OUTSIDE_REQUIRE_TENANT: Record<string, string> = {
  onSignup: "creates the business; the verification email goes out after it",
  updateUserProfile: "the caller's own display name only; may run before signup",
  onAcceptInvite: "refuses an unverified invitee itself",
  getCustomerInvoices: "customers, through requireVerifiedCustomer",
  getCustomerInvoiceDetail: "customers, through requireVerifiedCustomer",
  getCustomerQuotes: "customers, through requireVerifiedCustomer",
  getCustomerQuoteDetail: "customers, through requireVerifiedCustomer",
  sendPortalSignInLink: "no sign-in; links go only to addresses with documents",
  verifyInvoicePayToken: "no sign-in; the signed pay token is the credential",
  createPayTokenCheckoutSession: "no sign-in; the signed pay token is the credential",
  // D18 — the platform admin, for a business named in the input.
  setupCustomDomain: "the platform admin, through requirePlatformAdmin",
  removeCustomDomain: "the platform admin, through requirePlatformAdmin",
  recheckCustomDomain: "the platform admin, through requirePlatformAdmin",
};

const PLATFORM_ADMIN_CALLABLES = [
  "setupCustomDomain",
  "removeCustomDomain",
  "recheckCustomDomain",
];

const callables = Object.entries(deployedModule).flatMap(([name, value]) => {
  const endpoint = (value as { __endpoint?: { callableTrigger?: unknown } })
    .__endpoint;
  return endpoint?.callableTrigger
    ? [[name, value as unknown as DeployedCallable] as const]
    : [];
});
const tenantCallables = callables.filter(
  ([name]) => !(name in OUTSIDE_REQUIRE_TENANT),
);

function callable(name: string): DeployedCallable {
  const found = callables.find(([n]) => n === name);
  if (!found) throw new Error(`${name} is not a deployed callable`);
  return found[1];
}

const OWNER_UID = "u_owner";
const OWNER_EMAIL = "owner@acme.test";

// The owner's token once signup has set the tenant claims.
function owner(tenantId: string, emailVerified: boolean) {
  return {
    uid: OWNER_UID,
    claims: {
      email: OWNER_EMAIL,
      email_verified: emailVerified,
      tenantId,
      role: "owner" as const,
    },
  };
}

// Signs up the way the signup page does: before the email is verified.
async function signUpUnverified(): Promise<string> {
  await createAuthUser({ uid: OWNER_UID, email: OWNER_EMAIL, emailVerified: false });
  const { tenantId } = (await callable("onSignup").run(
    fakeRequest(
      { businessName: "Acme Plumbing" },
      { uid: OWNER_UID, claims: { email: OWNER_EMAIL, email_verified: false } },
    ),
  )) as { tenantId: string };
  return tenantId;
}

const invoiceInput = {
  customer: { name: "Jane Doe", email: "jane@example.com" },
  lineItems: [{ description: "Service call", quantity: 1, rate: 85 }],
  applyTax: true,
  dueDate: "2026-12-31",
};

beforeEach(async () => {
  await clearFirestore();
  await clearAuthUsers();
  sesSend.mockReset();
  sesSend.mockResolvedValue({ MessageId: "ses-test" });
  __setStripeClientForTest(null);
});

describe("every tenant callable refuses an unverified email (F-02)", () => {
  it("lists only deployed callables as outside requireTenant", () => {
    const names = callables.map(([name]) => name);
    expect(names).toEqual(expect.arrayContaining(Object.keys(OUTSIDE_REQUIRE_TENANT)));
    expect(tenantCallables.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        "createInvoice",
        "sendInvoiceEmail",
        "createInvitation",
        "startConnectOnboarding",
        "deleteCustomer",
        "previewInvoicePDF",
      ]),
    );
  });

  // The claim says false, or the token doesn't carry it at all.
  const unverifiedTokens = [
    owner("acme-plumbing", false),
    {
      uid: OWNER_UID,
      claims: { email: OWNER_EMAIL, tenantId: "acme-plumbing", role: "owner" as const },
    },
  ];

  for (const [name, fn] of tenantCallables) {
    it(`${name} refuses a token without email_verified: true`, async () => {
      for (const auth of unverifiedTokens) {
        await expect(fn.run(fakeRequest({}, auth))).rejects.toMatchObject({
          code: "failed-precondition",
          message: VERIFY_EMAIL_MESSAGE,
        });
      }
    });
  }
});

describe("an unverified owner changes nothing; verified, the same call works (F-02)", () => {
  it("createInvoice", async () => {
    const tenantId = await signUpUnverified();
    await expect(
      callable("createInvoice").run(fakeRequest(invoiceInput, owner(tenantId, false))),
    ).rejects.toThrow(VERIFY_EMAIL_MESSAGE);
    const counter = await testDb.doc(`tenants/${tenantId}/counters/invoice`).get();
    expect(counter.data()?.value).toBe(0);
    expect((await testDb.collection(`tenants/${tenantId}/invoices`).get()).empty).toBe(true);

    await expect(
      callable("createInvoice").run(fakeRequest(invoiceInput, owner(tenantId, true))),
    ).resolves.toEqual({ invoiceId: "INV-0001" });
  });

  it("sendInvoiceEmail", async () => {
    const tenantId = await signUpUnverified();
    const { invoiceId } = (await callable("createInvoice").run(
      fakeRequest(invoiceInput, owner(tenantId, true)),
    )) as { invoiceId: string };

    await expect(
      callable("sendInvoiceEmail").run(fakeRequest({ invoiceId }, owner(tenantId, false))),
    ).rejects.toThrow(VERIFY_EMAIL_MESSAGE);
    expect(sesSend).not.toHaveBeenCalled();
    const invoice = await testDb.doc(`tenants/${tenantId}/invoices/${invoiceId}`).get();
    expect(invoice.data()?.status).toBe("draft");
  });

  it("createInvitation", async () => {
    const tenantId = await signUpUnverified();
    const input = { email: "new.hire@acme.test", role: "staff" };
    const invitations = () => testDb.collection(`tenants/${tenantId}/invitations`).get();

    await expect(
      callable("createInvitation").run(fakeRequest(input, owner(tenantId, false))),
    ).rejects.toThrow(VERIFY_EMAIL_MESSAGE);
    expect((await invitations()).empty).toBe(true);
    expect(sesSend).not.toHaveBeenCalled();

    await callable("createInvitation").run(fakeRequest(input, owner(tenantId, true)));
    expect((await invitations()).size).toBe(1);
    expect(sesSend).toHaveBeenCalledTimes(1);
  });

  it("startConnectOnboarding", async () => {
    const tenantId = await signUpUnverified();
    const accountsCreate = vi.fn();
    __setStripeClientForTest({
      accounts: { create: accountsCreate, retrieve: vi.fn() },
      accountLinks: { create: vi.fn() },
    } as unknown as Stripe);

    await expect(
      callable("startConnectOnboarding").run(fakeRequest({}, owner(tenantId, false))),
    ).rejects.toThrow(VERIFY_EMAIL_MESSAGE);
    expect(accountsCreate).not.toHaveBeenCalled();
    const meta = await testDb.doc(`tenants/${tenantId}/meta/settings`).get();
    expect(meta.data()?.stripeAccountId).toBeNull();
  });
});

describe("what runs before verification still works (F-02)", () => {
  it("signup creates the business for an unverified account", async () => {
    const tenantId = await signUpUnverified();
    expect((await testDb.doc(`tenants/${tenantId}/meta/settings`).get()).exists).toBe(true);
    expect((await testAuth.getUser(OWNER_UID)).customClaims).toMatchObject({
      tenantId,
      role: "owner",
    });
  });

  it("updateUserProfile saves an unverified user's display name", async () => {
    await callable("updateUserProfile").run(
      fakeRequest(
        { displayName: "Jane Owner" },
        { uid: OWNER_UID, claims: { email: OWNER_EMAIL, email_verified: false } },
      ),
    );
    const user = await testDb.doc(`users/${OWNER_UID}`).get();
    expect(user.data()?.displayName).toBe("Jane Owner");
  });
});

describe("platform-admin callables (D18)", () => {
  it.each(PLATFORM_ADMIN_CALLABLES)(
    "%s refuses a platform admin whose email isn't verified",
    async (name) => {
      for (const emailVerified of [false, undefined]) {
        await expect(
          callable(name).run(
            fakeRequest(
              { tenantId: "acme-plumbing", domain: "invoices.acme.test" },
              {
                uid: "u_platform",
                claims: { email: "ops@techflow.test", platformAdmin: true, email_verified: emailVerified },
              },
            ),
          ),
        ).rejects.toMatchObject({
          code: "failed-precondition",
          message: VERIFY_EMAIL_MESSAGE,
        });
      }
    },
  );

  it.each(PLATFORM_ADMIN_CALLABLES)(
    "%s refuses a verified business owner",
    async (name) => {
      await expect(
        callable(name).run(
          fakeRequest(
            { tenantId: "acme-plumbing", domain: "invoices.acme.test" },
            owner("acme-plumbing", true),
          ),
        ),
      ).rejects.toMatchObject({ code: "permission-denied" });
    },
  );
});

describe("signed-in callables outside requireTenant check the email themselves", () => {
  it("onAcceptInvite refuses an unverified invitee", async () => {
    await expect(
      callable("onAcceptInvite").run(
        fakeRequest(
          { tenantId: "acme-plumbing", invitationId: "inv1", token: "raw" },
          { uid: "u_invitee", claims: { email: "invitee@acme.test", email_verified: false } },
        ),
      ),
    ).rejects.toMatchObject({
      code: "failed-precondition",
      message: "Verify your email before accepting an invitation.",
    });
  });

  it.each([
    "getCustomerInvoices",
    "getCustomerInvoiceDetail",
    "getCustomerQuotes",
    "getCustomerQuoteDetail",
  ])("%s refuses an unverified customer", async (name) => {
    await expect(
      callable(name).run(
        fakeRequest(
          { tenantId: "acme-plumbing", invoiceId: "INV-0001", quoteId: "QT-0001" },
          { uid: "u_customer", claims: { email: "jane@example.com", email_verified: false } },
        ),
      ),
    ).rejects.toMatchObject({
      code: "unauthenticated",
      message: "Verified email required.",
    });
  });
});
