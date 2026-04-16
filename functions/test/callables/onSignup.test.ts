import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAuthUsers,
  clearFirestore,
  createAuthUser,
  fakeRequest,
  testAuth,
  testDb,
} from "./_setup";
import { onSignupHandler } from "../../src/tenants/onSignup";

describe("onSignup", () => {
  beforeEach(async () => {
    await clearFirestore();
    await clearAuthUsers();
  });

  it("happy path — creates tenant, users doc, membership, and claims", async () => {
    await createAuthUser({
      uid: "u_owner",
      email: "owner@acme.test",
      emailVerified: true,
    });

    const { tenantId } = await onSignupHandler(
      fakeRequest(
        { businessName: "Acme Plumbing" },
        { uid: "u_owner", claims: { email: "owner@acme.test" } },
      ),
    );

    expect(tenantId).toBe("acme-plumbing");

    const meta = await testDb.doc(`tenants/${tenantId}/meta/settings`).get();
    expect(meta.exists).toBe(true);
    expect(meta.data()?.name).toBe("Acme Plumbing");
    expect(meta.data()?.taxRate).toBe(0.13);
    expect(meta.data()?.stripeStatus.chargesEnabled).toBe(false);

    const ent = await testDb
      .doc(`tenants/${tenantId}/entitlements/current`)
      .get();
    expect(ent.data()?.plan).toBe("starter");

    const invoiceCounter = await testDb
      .doc(`tenants/${tenantId}/counters/invoice`)
      .get();
    expect(invoiceCounter.data()?.value).toBe(0);

    const user = await testDb.doc(`users/u_owner`).get();
    expect(user.data()?.email).toBe("owner@acme.test");
    expect(user.data()?.defaultTenantId).toBe(tenantId);

    const membership = await testDb
      .doc(`userTenantMemberships/u_owner_${tenantId}`)
      .get();
    expect(membership.data()?.role).toBe("owner");
    expect(membership.data()?.invitedBy).toBeNull();

    const claims = (await testAuth.getUser("u_owner")).customClaims;
    expect(claims?.tenantId).toBe(tenantId);
    expect(claims?.role).toBe("owner");
  });

  it("rejects when caller is unauthenticated", async () => {
    await expect(
      onSignupHandler(fakeRequest({ businessName: "Foo" }, null)),
    ).rejects.toThrow(/Sign in required/);
  });

  it("rejects when businessName is too short", async () => {
    await createAuthUser({ uid: "u1", email: "u1@x.test" });
    await expect(
      onSignupHandler(
        fakeRequest(
          { businessName: "A" },
          { uid: "u1", claims: { email: "u1@x.test" } },
        ),
      ),
    ).rejects.toThrow(/2–100 characters/);
  });

  it("rejects if user already has a membership (idempotent-guard)", async () => {
    await createAuthUser({ uid: "u_dup", email: "dup@x.test" });
    await onSignupHandler(
      fakeRequest(
        { businessName: "First Co" },
        { uid: "u_dup", claims: { email: "dup@x.test" } },
      ),
    );

    await expect(
      onSignupHandler(
        fakeRequest(
          { businessName: "Second Co" },
          { uid: "u_dup", claims: { email: "dup@x.test" } },
        ),
      ),
    ).rejects.toThrow(/already a member/);
  });

  it("generates suffix when base slug is taken", async () => {
    await createAuthUser({ uid: "u_a", email: "a@x.test" });
    await createAuthUser({ uid: "u_b", email: "b@x.test" });

    const { tenantId: first } = await onSignupHandler(
      fakeRequest(
        { businessName: "Collision Co" },
        { uid: "u_a", claims: { email: "a@x.test" } },
      ),
    );
    const { tenantId: second } = await onSignupHandler(
      fakeRequest(
        { businessName: "Collision Co" },
        { uid: "u_b", claims: { email: "b@x.test" } },
      ),
    );

    expect(first).toBe("collision-co");
    expect(second).toBe("collision-co-1");
  });

  it("rejects when auth has no email", async () => {
    await createAuthUser({ uid: "u_noemail" });
    await expect(
      onSignupHandler(
        fakeRequest({ businessName: "No Email Co" }, { uid: "u_noemail" }),
      ),
    ).rejects.toThrow(/missing an email/);
  });
});
