import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be set before handler imports
// ---------------------------------------------------------------------------
vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({
    value: () => {
      if (name === "STRIPE_SECRET_KEY") return "sk_test_fake";
      return "mock-secret";
    },
  }),
}));

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import {
  clearAuthUsers,
  clearFirestore,
  createAuthUser,
  fakeRequest,
  testDb,
} from "./_setup";
import { onSignupHandler } from "../../src/tenants/onSignup";
import { startConnectOnboardingHandler } from "../../src/stripe/startConnectOnboarding";
import { completeConnectOnboardingHandler } from "../../src/stripe/completeConnectOnboarding";
import { __setStripeClientForTest } from "../../src/shared/stripe";
import { FieldValue } from "firebase-admin/firestore";
import type Stripe from "stripe";

const OWNER_UID = "owner1";
const OWNER_EMAIL = "owner@acme.test";

async function seedOwner(): Promise<string> {
  await createAuthUser({
    uid: OWNER_UID,
    email: OWNER_EMAIL,
    emailVerified: true,
  });
  const { tenantId } = await onSignupHandler(
    fakeRequest(
      { businessName: "Acme" },
      { uid: OWNER_UID, claims: { email: OWNER_EMAIL } },
    ),
  );
  // Feature-gate: enable stripePayments for the tenant.
  await testDb.doc(`tenants/${tenantId}/entitlements/current`).set(
    { features: { stripePayments: true } },
    { merge: true },
  );
  return tenantId;
}

function fakeStripeClient(opts: {
  accountsCreate?: ReturnType<typeof vi.fn>;
  accountsRetrieve?: ReturnType<typeof vi.fn>;
  accountLinksCreate?: ReturnType<typeof vi.fn>;
}): Stripe {
  return {
    accounts: {
      create: opts.accountsCreate ?? vi.fn(),
      retrieve: opts.accountsRetrieve ?? vi.fn(),
    },
    accountLinks: {
      create: opts.accountLinksCreate ?? vi.fn(),
    },
  } as unknown as Stripe;
}

describe("startConnectOnboarding", () => {
  beforeEach(async () => {
    await clearFirestore();
    await clearAuthUsers();
    __setStripeClientForTest(null);
  });

  it("creates a new Express account when tenant has no stripeAccountId", async () => {
    const tenantId = await seedOwner();

    const create = vi.fn().mockResolvedValue({ id: "acct_new_123" });
    const retrieve = vi.fn();
    const linksCreate = vi
      .fn()
      .mockResolvedValue({ url: "https://connect.stripe.com/setup/abc" });
    __setStripeClientForTest(
      fakeStripeClient({
        accountsCreate: create,
        accountsRetrieve: retrieve,
        accountLinksCreate: linksCreate,
      }),
    );

    const res = await startConnectOnboardingHandler(
      fakeRequest(
        {},
        {
          uid: OWNER_UID,
          claims: {
            email: OWNER_EMAIL,
            tenantId,
            role: "owner",
          },
        },
      ),
    );

    expect(res.accountId).toBe("acct_new_123");
    expect(res.url).toBe("https://connect.stripe.com/setup/abc");
    expect(create).toHaveBeenCalledTimes(1);
    const createArg = create.mock.calls[0][0];
    expect(createArg.type).toBe("express");
    expect(createArg.country).toBe("CA"); // CAD default
    expect(createArg.metadata).toEqual({ tenantId });
    expect(retrieve).not.toHaveBeenCalled();

    const meta = await testDb.doc(`tenants/${tenantId}/meta/settings`).get();
    expect(meta.data()?.stripeAccountId).toBe("acct_new_123");

    const linksArg = linksCreate.mock.calls[0][0];
    expect(linksArg.account).toBe("acct_new_123");
    expect(linksArg.type).toBe("account_onboarding");
    expect(linksArg.refresh_url).toContain("/billing?stripe=refresh");
    expect(linksArg.return_url).toContain("/billing/return");
  });

  it("reuses existing accountId when one is persisted and still valid", async () => {
    const tenantId = await seedOwner();
    await testDb.doc(`tenants/${tenantId}/meta/settings`).set(
      { stripeAccountId: "acct_existing_456" },
      { merge: true },
    );

    const create = vi.fn();
    const retrieve = vi.fn().mockResolvedValue({ id: "acct_existing_456" });
    const linksCreate = vi
      .fn()
      .mockResolvedValue({ url: "https://connect.stripe.com/setup/reused" });
    __setStripeClientForTest(
      fakeStripeClient({
        accountsCreate: create,
        accountsRetrieve: retrieve,
        accountLinksCreate: linksCreate,
      }),
    );

    const res = await startConnectOnboardingHandler(
      fakeRequest(
        {},
        {
          uid: OWNER_UID,
          claims: {
            email: OWNER_EMAIL,
            tenantId,
            role: "owner",
          },
        },
      ),
    );

    expect(res.accountId).toBe("acct_existing_456");
    expect(create).not.toHaveBeenCalled();
    expect(retrieve).toHaveBeenCalledWith("acct_existing_456");
  });

  it("drops stale accountId when Stripe returns resource_missing and creates a fresh one", async () => {
    const tenantId = await seedOwner();
    await testDb.doc(`tenants/${tenantId}/meta/settings`).set(
      { stripeAccountId: "acct_stale_789" },
      { merge: true },
    );

    const err = Object.assign(new Error("No such account"), {
      code: "resource_missing",
    });
    const create = vi.fn().mockResolvedValue({ id: "acct_fresh_111" });
    const retrieve = vi.fn().mockRejectedValue(err);
    const linksCreate = vi
      .fn()
      .mockResolvedValue({ url: "https://connect.stripe.com/setup/fresh" });
    __setStripeClientForTest(
      fakeStripeClient({
        accountsCreate: create,
        accountsRetrieve: retrieve,
        accountLinksCreate: linksCreate,
      }),
    );

    const res = await startConnectOnboardingHandler(
      fakeRequest(
        {},
        {
          uid: OWNER_UID,
          claims: {
            email: OWNER_EMAIL,
            tenantId,
            role: "owner",
          },
        },
      ),
    );

    expect(res.accountId).toBe("acct_fresh_111");
    expect(create).toHaveBeenCalledTimes(1);

    const meta = await testDb.doc(`tenants/${tenantId}/meta/settings`).get();
    expect(meta.data()?.stripeAccountId).toBe("acct_fresh_111");
  });

  it("selects US country when tenant currency is USD", async () => {
    const tenantId = await seedOwner();
    await testDb.doc(`tenants/${tenantId}/meta/settings`).set(
      { currency: "USD" },
      { merge: true },
    );

    const create = vi.fn().mockResolvedValue({ id: "acct_us_222" });
    const linksCreate = vi.fn().mockResolvedValue({ url: "https://x.test" });
    __setStripeClientForTest(
      fakeStripeClient({
        accountsCreate: create,
        accountsRetrieve: vi.fn(),
        accountLinksCreate: linksCreate,
      }),
    );

    await startConnectOnboardingHandler(
      fakeRequest(
        {},
        {
          uid: OWNER_UID,
          claims: {
            email: OWNER_EMAIL,
            tenantId,
            role: "owner",
          },
        },
      ),
    );

    expect(create.mock.calls[0][0].country).toBe("US");
  });

  it("rejects staff caller", async () => {
    const tenantId = await seedOwner();
    __setStripeClientForTest(fakeStripeClient({}));

    await expect(
      startConnectOnboardingHandler(
        fakeRequest(
          {},
          {
            uid: "staffUser",
            claims: {
              email: "staff@acme.test",
              tenantId,
              role: "staff",
            },
          },
        ),
      ),
    ).rejects.toThrow(/Requires one of: owner, admin/);
  });

  it("rejects when stripePayments feature is disabled", async () => {
    const tenantId = await seedOwner();
    await testDb.doc(`tenants/${tenantId}/entitlements/current`).set(
      { features: { stripePayments: false } },
      { merge: true },
    );
    __setStripeClientForTest(fakeStripeClient({}));

    await expect(
      startConnectOnboardingHandler(
        fakeRequest(
          {},
          {
            uid: OWNER_UID,
            claims: {
              email: OWNER_EMAIL,
              tenantId,
              role: "owner",
            },
          },
        ),
      ),
    ).rejects.toThrow(/stripePayments/);
  });
});

describe("completeConnectOnboarding", () => {
  beforeEach(async () => {
    await clearFirestore();
    await clearAuthUsers();
    __setStripeClientForTest(null);
  });

  it("atomically mirrors stripeStatus and writes the reverse-lookup doc", async () => {
    const tenantId = await seedOwner();
    await testDb.doc(`tenants/${tenantId}/meta/settings`).set(
      { stripeAccountId: "acct_ready_999" },
      { merge: true },
    );

    const retrieve = vi.fn().mockResolvedValue({
      id: "acct_ready_999",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: { currently_due: [], disabled_reason: null },
    });
    __setStripeClientForTest(
      fakeStripeClient({ accountsRetrieve: retrieve }),
    );

    const res = await completeConnectOnboardingHandler(
      fakeRequest(
        {},
        {
          uid: OWNER_UID,
          claims: {
            email: OWNER_EMAIL,
            tenantId,
            role: "owner",
          },
        },
      ),
    );

    expect(res).toEqual({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      currentlyDue: [],
      disabledReason: null,
    });

    const meta = await testDb.doc(`tenants/${tenantId}/meta/settings`).get();
    const status = meta.data()?.stripeStatus as Record<string, unknown>;
    expect(status.chargesEnabled).toBe(true);
    expect(status.payoutsEnabled).toBe(true);
    expect(status.detailsSubmitted).toBe(true);
    expect(status.currentlyDue).toEqual([]);
    expect(status.disabledReason).toBeNull();

    const lookup = await testDb.doc(`stripeAccounts/acct_ready_999`).get();
    expect(lookup.exists).toBe(true);
    expect(lookup.data()?.tenantId).toBe(tenantId);
    expect(lookup.data()?.linkedAt).toBeDefined();
  });

  it("mirrors not-yet-enabled account state without throwing", async () => {
    const tenantId = await seedOwner();
    await testDb.doc(`tenants/${tenantId}/meta/settings`).set(
      { stripeAccountId: "acct_pending_888" },
      { merge: true },
    );

    const retrieve = vi.fn().mockResolvedValue({
      id: "acct_pending_888",
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements: {
        currently_due: ["business_profile.url", "tos_acceptance.date"],
        disabled_reason: "requirements.past_due",
      },
    });
    __setStripeClientForTest(
      fakeStripeClient({ accountsRetrieve: retrieve }),
    );

    const res = await completeConnectOnboardingHandler(
      fakeRequest(
        {},
        {
          uid: OWNER_UID,
          claims: {
            email: OWNER_EMAIL,
            tenantId,
            role: "owner",
          },
        },
      ),
    );

    expect(res.chargesEnabled).toBe(false);
    expect(res.currentlyDue).toEqual([
      "business_profile.url",
      "tos_acceptance.date",
    ]);
    expect(res.disabledReason).toBe("requirements.past_due");

    // Reverse-lookup doc must still be written even when chargesEnabled=false,
    // because the Connect webhook needs to route account.updated events.
    const lookup = await testDb.doc(`stripeAccounts/acct_pending_888`).get();
    expect(lookup.exists).toBe(true);
  });

  it("rejects when no stripeAccountId is persisted", async () => {
    const tenantId = await seedOwner();
    __setStripeClientForTest(fakeStripeClient({}));

    await expect(
      completeConnectOnboardingHandler(
        fakeRequest(
          {},
          {
            uid: OWNER_UID,
            claims: {
              email: OWNER_EMAIL,
              tenantId,
              role: "owner",
            },
          },
        ),
      ),
    ).rejects.toThrow(/Start Stripe onboarding/);
  });

  it("rejects staff caller", async () => {
    const tenantId = await seedOwner();
    await testDb.doc(`tenants/${tenantId}/meta/settings`).set(
      { stripeAccountId: "acct_ignored" },
      { merge: true },
    );
    __setStripeClientForTest(fakeStripeClient({}));

    await expect(
      completeConnectOnboardingHandler(
        fakeRequest(
          {},
          {
            uid: "staffUser",
            claims: {
              email: "staff@acme.test",
              tenantId,
              role: "staff",
            },
          },
        ),
      ),
    ).rejects.toThrow(/Requires one of: owner, admin/);
  });

  it("rejects when stripePayments feature is disabled", async () => {
    const tenantId = await seedOwner();
    await testDb.doc(`tenants/${tenantId}/entitlements/current`).set(
      { features: { stripePayments: false } },
      { merge: true },
    );
    __setStripeClientForTest(fakeStripeClient({}));

    await expect(
      completeConnectOnboardingHandler(
        fakeRequest(
          {},
          {
            uid: OWNER_UID,
            claims: {
              email: OWNER_EMAIL,
              tenantId,
              role: "owner",
            },
          },
        ),
      ),
    ).rejects.toThrow(/stripePayments/);
  });
});
