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

function signup(uid: string, email: string, businessName: string) {
  return onSignupHandler(
    fakeRequest({ businessName }, { uid, claims: { email } }),
  );
}

async function tenantIds(): Promise<string[]> {
  const refs = await testDb.collection("tenants").listDocuments();
  return refs.map((r) => r.id).sort();
}

async function membershipCount(uid: string): Promise<number> {
  return (
    await testDb.collection("userTenantMemberships").where("uid", "==", uid).get()
  ).size;
}

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
    // D5 — Reply-To defaults to the owner's signup email.
    expect(meta.data()?.contactEmail).toBe("owner@acme.test");
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

    // A-12 — the signup record that makes a repeat call safe.
    const record = await testDb.doc("signups/u_owner").get();
    expect(record.data()).toMatchObject({ uid: "u_owner", tenantId });

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
    await expect(signup("u1", "u1@x.test", "A")).rejects.toThrow(
      /2–100 characters/,
    );
  });

  it("generates suffix when base slug is taken", async () => {
    await createAuthUser({ uid: "u_a", email: "a@x.test" });
    await createAuthUser({ uid: "u_b", email: "b@x.test" });

    const { tenantId: first } = await signup("u_a", "a@x.test", "Collision Co");
    const { tenantId: second } = await signup("u_b", "b@x.test", "Collision Co");

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

  // -------------------------------------------------------------------------
  // A-12 — the membership check and the tenant id claim are transactional.
  // -------------------------------------------------------------------------

  it("A-12: two businesses with the same name signing up at once get separate tenants", async () => {
    await createAuthUser({ uid: "u_a", email: "a@x.test" });
    await createAuthUser({ uid: "u_b", email: "b@x.test" });

    const [a, b] = await Promise.all([
      signup("u_a", "a@x.test", "Race Plumbing"),
      signup("u_b", "b@x.test", "Race Plumbing"),
    ]);

    expect([a.tenantId, b.tenantId].sort()).toEqual([
      "race-plumbing",
      "race-plumbing-1",
    ]);
    // Neither overwrote the other: each tenant still belongs to its own owner.
    const metaA = await testDb.doc(`tenants/${a.tenantId}/meta/settings`).get();
    const metaB = await testDb.doc(`tenants/${b.tenantId}/meta/settings`).get();
    expect(metaA.data()?.contactEmail).toBe("a@x.test");
    expect(metaB.data()?.contactEmail).toBe("b@x.test");
    expect((await testAuth.getUser("u_a")).customClaims?.tenantId).toBe(a.tenantId);
    expect((await testAuth.getUser("u_b")).customClaims?.tenantId).toBe(b.tenantId);
  });

  it("A-12: a double submit creates one tenant and both calls return it", async () => {
    await createAuthUser({ uid: "u_dup", email: "dup@x.test" });

    const [first, second] = await Promise.all([
      signup("u_dup", "dup@x.test", "Double Co"),
      signup("u_dup", "dup@x.test", "Double Co"),
    ]);

    expect(second.tenantId).toBe(first.tenantId);
    expect(await tenantIds()).toEqual([first.tenantId]);
    expect(await membershipCount("u_dup")).toBe(1);
  });

  it("A-12: a repeat call returns the existing tenant and restores lost claims", async () => {
    await createAuthUser({ uid: "u_retry", email: "retry@x.test" });
    const { tenantId } = await signup("u_retry", "retry@x.test", "First Co");

    // The claims write after the transaction failed, or the client retried
    // before refreshing its token.
    await testAuth.setCustomUserClaims("u_retry", null);

    const again = await signup("u_retry", "retry@x.test", "Second Co");
    expect(again.tenantId).toBe(tenantId);
    expect(await tenantIds()).toEqual([tenantId]);
    const claims = (await testAuth.getUser("u_retry")).customClaims;
    expect(claims).toMatchObject({ tenantId, role: "owner" });
  });

  it("A-12: rejects a caller whose token already carries a tenant", async () => {
    await createAuthUser({ uid: "u_member", email: "member@x.test" });
    await expect(
      onSignupHandler(
        fakeRequest(
          { businessName: "Second Co" },
          { uid: "u_member", claims: { email: "member@x.test", tenantId: "t1" } },
        ),
      ),
    ).rejects.toThrow(/already a member/);
    expect(await tenantIds()).toEqual([]);
  });

  it("A-12: rejects an invited member who never signed up", async () => {
    await createAuthUser({ uid: "u_invited", email: "invited@x.test" });
    await testDb.doc("userTenantMemberships/u_invited_other-co").set({
      uid: "u_invited",
      tenantId: "other-co",
      role: "staff",
      invitedBy: "u_boss",
      createdAt: new Date(),
      deletedAt: null,
    });

    await expect(
      signup("u_invited", "invited@x.test", "Side Hustle"),
    ).rejects.toThrow(/already a member/);
    expect(await tenantIds()).toEqual([]);
  });

  it("A-12: keeps a display name saved before signup", async () => {
    await createAuthUser({ uid: "u_named", email: "named@x.test" });
    await testDb.doc("users/u_named").set({
      displayName: "Robert",
      updatedAt: new Date(),
    });

    const { tenantId } = await signup("u_named", "named@x.test", "Named Co");

    const user = (await testDb.doc("users/u_named").get()).data();
    expect(user).toMatchObject({
      uid: "u_named",
      email: "named@x.test",
      displayName: "Robert",
      defaultTenantId: tenantId,
    });
  });
});
