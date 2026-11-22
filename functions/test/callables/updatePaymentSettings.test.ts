import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAuthUsers,
  clearFirestore,
  createAuthUser,
  fakeRequest,
  registerMembers,
  seedMembership,
  testDb,
} from "./_setup";
import { updatePaymentSettingsHandler } from "../../src/tenants/updatePaymentSettings";
import { onSignupHandler } from "../../src/tenants/onSignup";

async function seedOwner(): Promise<string> {
  await createAuthUser({
    uid: "owner1",
    email: "owner@acme.test",
    emailVerified: true,
  });
  const { tenantId } = await onSignupHandler(
    fakeRequest(
      { businessName: "Acme" },
      { uid: "owner1", claims: { email: "owner@acme.test" } },
    ),
  );
  return tenantId;
}

// D3 — surcharging is off by default; tests that exercise it enable the flag
// the way the platform admin would.
// A member of a business whose settings don't exist yet.
registerMembers({ uid: "someone", claims: { tenantId: "ghost", role: "owner" } });

async function enableCardSurcharge(tenantId: string): Promise<void> {
  await testDb
    .doc(`tenants/${tenantId}/entitlements/current`)
    .set({ features: { cardSurcharge: true } }, { merge: true });
}

describe("updatePaymentSettings", () => {
  beforeEach(async () => {
    await clearFirestore();
    await clearAuthUsers();
  });

  it("owner sets etransferEmail", async () => {
    const tenantId = await seedOwner();
    const res = await updatePaymentSettingsHandler(
      fakeRequest(
        { etransferEmail: "Deposits@ACME.Test" },
        { uid: "owner1", claims: { tenantId, role: "owner", email_verified: true } },
      ),
    );
    expect(res).toEqual({ ok: true });
    const meta = await testDb.doc(`tenants/${tenantId}/meta/settings`).get();
    expect(meta.data()?.etransferEmail).toBe("deposits@acme.test");
  });

  it("accepts null to clear etransferEmail", async () => {
    const tenantId = await seedOwner();
    await updatePaymentSettingsHandler(
      fakeRequest(
        { etransferEmail: "x@y.test" },
        { uid: "owner1", claims: { tenantId, role: "owner", email_verified: true } },
      ),
    );
    await updatePaymentSettingsHandler(
      fakeRequest(
        { etransferEmail: null },
        { uid: "owner1", claims: { tenantId, role: "owner", email_verified: true } },
      ),
    );
    const meta = await testDb.doc(`tenants/${tenantId}/meta/settings`).get();
    expect(meta.data()?.etransferEmail).toBeNull();
  });

  it("rejects invalid etransferEmail format", async () => {
    const tenantId = await seedOwner();
    await expect(
      updatePaymentSettingsHandler(
        fakeRequest(
          { etransferEmail: "not-an-email" },
          { uid: "owner1", claims: { tenantId, role: "owner", email_verified: true } },
        ),
      ),
    ).rejects.toThrow(/not a valid address/);
  });

  it("enabling surcharging is refused while the cardSurcharge feature is off (D3 default)", async () => {
    const tenantId = await seedOwner();
    await expect(
      updatePaymentSettingsHandler(
        fakeRequest(
          { chargeCustomerCardFees: true, acknowledgeSurcharge: true },
          { uid: "owner1", claims: { tenantId, role: "owner", email_verified: true } },
        ),
      ),
    ).rejects.toThrow(/Feature 'cardSurcharge' is not enabled/);
    const meta = await testDb.doc(`tenants/${tenantId}/meta/settings`).get();
    expect(meta.data()?.chargeCustomerCardFees).toBe(false);
    expect(meta.data()?.surchargeAcknowledgedAt).toBeNull();
  });

  it("disabling surcharging is always allowed, even with the feature off", async () => {
    const tenantId = await seedOwner();
    const res = await updatePaymentSettingsHandler(
      fakeRequest(
        { chargeCustomerCardFees: false },
        { uid: "owner1", claims: { tenantId, role: "owner", email_verified: true } },
      ),
    );
    expect(res).toEqual({ ok: true });
  });

  it("enabling surcharging without acknowledgment is refused", async () => {
    const tenantId = await seedOwner();
    await enableCardSurcharge(tenantId);
    await expect(
      updatePaymentSettingsHandler(
        fakeRequest(
          { chargeCustomerCardFees: true },
          { uid: "owner1", claims: { tenantId, role: "owner", email_verified: true } },
        ),
      ),
    ).rejects.toThrow(/acknowledging/);
  });

  it("enabling surcharging WITH acknowledgeSurcharge:true stamps timestamp", async () => {
    const tenantId = await seedOwner();
    await enableCardSurcharge(tenantId);
    await updatePaymentSettingsHandler(
      fakeRequest(
        { chargeCustomerCardFees: true, acknowledgeSurcharge: true },
        { uid: "owner1", claims: { tenantId, role: "owner", email_verified: true } },
      ),
    );
    const meta = await testDb.doc(`tenants/${tenantId}/meta/settings`).get();
    expect(meta.data()?.chargeCustomerCardFees).toBe(true);
    expect(meta.data()?.surchargeAcknowledgedAt).toBeDefined();
    expect(meta.data()?.surchargeAcknowledgedAt).not.toBeNull();
  });

  it("once acknowledged, later edits succeed without re-acknowledging", async () => {
    const tenantId = await seedOwner();
    await enableCardSurcharge(tenantId);
    await updatePaymentSettingsHandler(
      fakeRequest(
        { chargeCustomerCardFees: true, acknowledgeSurcharge: true },
        { uid: "owner1", claims: { tenantId, role: "owner", email_verified: true } },
      ),
    );
    const before = await testDb
      .doc(`tenants/${tenantId}/meta/settings`)
      .get();
    const stampedAt = before.data()?.surchargeAcknowledgedAt;

    // Toggle off then on again — should not require acknowledgment flag.
    await updatePaymentSettingsHandler(
      fakeRequest(
        { chargeCustomerCardFees: false },
        { uid: "owner1", claims: { tenantId, role: "owner", email_verified: true } },
      ),
    );
    await updatePaymentSettingsHandler(
      fakeRequest(
        { chargeCustomerCardFees: true },
        { uid: "owner1", claims: { tenantId, role: "owner", email_verified: true } },
      ),
    );
    const after = await testDb
      .doc(`tenants/${tenantId}/meta/settings`)
      .get();
    expect(after.data()?.chargeCustomerCardFees).toBe(true);
    // Timestamp is immutable — same value as originally stamped.
    expect(
      (after.data()?.surchargeAcknowledgedAt as { toMillis(): number }).toMillis(),
    ).toBe(
      (stampedAt as { toMillis(): number }).toMillis(),
    );
  });

  it("hard-caps cardFeePercent at 2.4", async () => {
    const tenantId = await seedOwner();
    await expect(
      updatePaymentSettingsHandler(
        fakeRequest(
          { cardFeePercent: 3.0 },
          { uid: "owner1", claims: { tenantId, role: "owner", email_verified: true } },
        ),
      ),
    ).rejects.toThrow(/hard-capped at 2.4/);
  });

  it("rejects negative cardFeePercent", async () => {
    const tenantId = await seedOwner();
    await expect(
      updatePaymentSettingsHandler(
        fakeRequest(
          { cardFeePercent: -1 },
          { uid: "owner1", claims: { tenantId, role: "owner", email_verified: true } },
        ),
      ),
    ).rejects.toThrow(/non-negative/);
  });

  it("accepts cardFeePercent at the cap (2.4 exact)", async () => {
    const tenantId = await seedOwner();
    await updatePaymentSettingsHandler(
      fakeRequest(
        { cardFeePercent: 2.4 },
        { uid: "owner1", claims: { tenantId, role: "owner", email_verified: true } },
      ),
    );
    const meta = await testDb.doc(`tenants/${tenantId}/meta/settings`).get();
    expect(meta.data()?.cardFeePercent).toBe(2.4);
  });

  it("rejects non-boolean chargeCustomerCardFees", async () => {
    const tenantId = await seedOwner();
    await expect(
      updatePaymentSettingsHandler(
        fakeRequest(
          { chargeCustomerCardFees: "true" } as never,
          { uid: "owner1", claims: { tenantId, role: "owner", email_verified: true } },
        ),
      ),
    ).rejects.toThrow(/must be a boolean/);
  });

  it("rejects staff caller", async () => {
    const tenantId = await seedOwner();
    await seedMembership("staffUser", tenantId, "staff");
    await expect(
      updatePaymentSettingsHandler(
        fakeRequest(
          { etransferEmail: "x@y.test" },
          { uid: "staffUser", claims: { tenantId, role: "staff", email_verified: true } },
        ),
      ),
    ).rejects.toThrow(/Requires one of: owner, admin/);
  });

  it("rejects when no editable fields supplied", async () => {
    const tenantId = await seedOwner();
    await expect(
      updatePaymentSettingsHandler(
        fakeRequest({}, { uid: "owner1", claims: { tenantId, role: "owner", email_verified: true } }),
      ),
    ).rejects.toThrow(/No editable fields/);
  });

  it("rejects when tenant meta does not exist (no onSignup yet)", async () => {
    await expect(
      updatePaymentSettingsHandler(
        fakeRequest(
          { etransferEmail: "x@y.test" },
          { uid: "someone", claims: { tenantId: "ghost", role: "owner", email_verified: true } },
        ),
      ),
    ).rejects.toThrow(/Tenant settings not found/);
  });
});
