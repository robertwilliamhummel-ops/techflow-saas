import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAuthUsers,
  clearFirestore,
  createAuthUser,
  fakeRequest,
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
        { uid: "owner1", claims: { tenantId, role: "owner" } },
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
        { uid: "owner1", claims: { tenantId, role: "owner" } },
      ),
    );
    await updatePaymentSettingsHandler(
      fakeRequest(
        { etransferEmail: null },
        { uid: "owner1", claims: { tenantId, role: "owner" } },
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
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/not a valid address/);
  });

  it("enabling surcharging without acknowledgment is refused", async () => {
    const tenantId = await seedOwner();
    await expect(
      updatePaymentSettingsHandler(
        fakeRequest(
          { chargeCustomerCardFees: true },
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/acknowledging/);
  });

  it("enabling surcharging WITH acknowledgeSurcharge:true stamps timestamp", async () => {
    const tenantId = await seedOwner();
    await updatePaymentSettingsHandler(
      fakeRequest(
        { chargeCustomerCardFees: true, acknowledgeSurcharge: true },
        { uid: "owner1", claims: { tenantId, role: "owner" } },
      ),
    );
    const meta = await testDb.doc(`tenants/${tenantId}/meta/settings`).get();
    expect(meta.data()?.chargeCustomerCardFees).toBe(true);
    expect(meta.data()?.surchargeAcknowledgedAt).toBeDefined();
    expect(meta.data()?.surchargeAcknowledgedAt).not.toBeNull();
  });

  it("once acknowledged, later edits succeed without re-acknowledging", async () => {
    const tenantId = await seedOwner();
    await updatePaymentSettingsHandler(
      fakeRequest(
        { chargeCustomerCardFees: true, acknowledgeSurcharge: true },
        { uid: "owner1", claims: { tenantId, role: "owner" } },
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
        { uid: "owner1", claims: { tenantId, role: "owner" } },
      ),
    );
    await updatePaymentSettingsHandler(
      fakeRequest(
        { chargeCustomerCardFees: true },
        { uid: "owner1", claims: { tenantId, role: "owner" } },
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
          { uid: "owner1", claims: { tenantId, role: "owner" } },
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
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/non-negative/);
  });

  it("accepts cardFeePercent at the cap (2.4 exact)", async () => {
    const tenantId = await seedOwner();
    await updatePaymentSettingsHandler(
      fakeRequest(
        { cardFeePercent: 2.4 },
        { uid: "owner1", claims: { tenantId, role: "owner" } },
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
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/must be a boolean/);
  });

  it("rejects staff caller", async () => {
    const tenantId = await seedOwner();
    await expect(
      updatePaymentSettingsHandler(
        fakeRequest(
          { etransferEmail: "x@y.test" },
          { uid: "staffUser", claims: { tenantId, role: "staff" } },
        ),
      ),
    ).rejects.toThrow(/Requires one of: owner, admin/);
  });

  it("rejects when no editable fields supplied", async () => {
    const tenantId = await seedOwner();
    await expect(
      updatePaymentSettingsHandler(
        fakeRequest({}, { uid: "owner1", claims: { tenantId, role: "owner" } }),
      ),
    ).rejects.toThrow(/No editable fields/);
  });

  it("rejects when tenant meta does not exist (no onSignup yet)", async () => {
    await expect(
      updatePaymentSettingsHandler(
        fakeRequest(
          { etransferEmail: "x@y.test" },
          { uid: "someone", claims: { tenantId: "ghost", role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/Tenant settings not found/);
  });
});
