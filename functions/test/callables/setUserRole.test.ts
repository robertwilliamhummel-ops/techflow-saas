import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAuthUsers,
  clearFirestore,
  createAuthUser,
  fakeRequest,
  testAuth,
  testDb,
} from "./_setup";
import { setUserRoleHandler } from "../../src/tenants/setUserRole";
import { onSignupHandler } from "../../src/tenants/onSignup";

async function seedTenantWithOwnerAndStaff() {
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
  await createAuthUser({
    uid: "staff1",
    email: "staff@acme.test",
    emailVerified: true,
  });
  await testDb.doc(`userTenantMemberships/staff1_${tenantId}`).set({
    uid: "staff1",
    tenantId,
    role: "staff",
    invitedBy: "owner1",
    createdAt: new Date(),
    deletedAt: null,
  });
  await testAuth.setCustomUserClaims("staff1", {
    tenantId,
    role: "staff",
  });
  return tenantId;
}

describe("setUserRole", () => {
  beforeEach(async () => {
    await clearFirestore();
    await clearAuthUsers();
  });

  it("owner promotes staff to admin — membership + claims updated", async () => {
    const tenantId = await seedTenantWithOwnerAndStaff();

    const res = await setUserRoleHandler(
      fakeRequest(
        { targetUid: "staff1", role: "admin" },
        { uid: "owner1", claims: { tenantId, role: "owner" } },
      ),
    );
    expect(res).toEqual({ ok: true });

    const membership = await testDb
      .doc(`userTenantMemberships/staff1_${tenantId}`)
      .get();
    expect(membership.data()?.role).toBe("admin");

    const claims = (await testAuth.getUser("staff1")).customClaims;
    expect(claims?.role).toBe("admin");
    expect(claims?.tenantId).toBe(tenantId);
  });

  it("rejects when caller is not an owner", async () => {
    const tenantId = await seedTenantWithOwnerAndStaff();
    await expect(
      setUserRoleHandler(
        fakeRequest(
          { targetUid: "staff1", role: "admin" },
          { uid: "staff1", claims: { tenantId, role: "staff" } },
        ),
      ),
    ).rejects.toThrow(/Requires one of: owner/);
  });

  it("rejects when owner tries to change own role", async () => {
    const tenantId = await seedTenantWithOwnerAndStaff();
    await expect(
      setUserRoleHandler(
        fakeRequest(
          { targetUid: "owner1", role: "admin" },
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/cannot change their own role/);
  });

  it("rejects when target is not a member", async () => {
    const tenantId = await seedTenantWithOwnerAndStaff();
    await expect(
      setUserRoleHandler(
        fakeRequest(
          { targetUid: "stranger", role: "admin" },
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/not an active member/);
  });

  it("rejects invalid role value", async () => {
    const tenantId = await seedTenantWithOwnerAndStaff();
    await expect(
      setUserRoleHandler(
        fakeRequest(
          { targetUid: "staff1", role: "superuser" },
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/role must be one of/);
  });

  it("rejects when caller has no tenant claim", async () => {
    await createAuthUser({ uid: "loner", email: "l@x.test" });
    await expect(
      setUserRoleHandler(
        fakeRequest(
          { targetUid: "staff1", role: "admin" },
          { uid: "loner" },
        ),
      ),
    ).rejects.toThrow(/Tenant membership required/);
  });
});
