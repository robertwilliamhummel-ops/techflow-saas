// D21 — an owner removes a teammate, and a removed member's tenant access ends
// at once: requireTenant refuses a deleted (or missing) membership even while
// the member's ID token still carries the tenant claim.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAuthUsers,
  clearFirestore,
  createAuthUser,
  fakeRequest,
  registerMembers,
  testAuth,
  testDb,
} from "./_setup";

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { removeMemberHandler } from "../../src/tenants/removeMember";
import { listMembersHandler } from "../../src/tenants/listMembers";
import { upsertCustomerHandler } from "../../src/customers/upsertCustomer";
import { onSignupHandler } from "../../src/tenants/onSignup";
import { REMOVED_MEMBER_MESSAGE } from "../../src/shared/auth";

const TENANT = "acme-plumbing";
const OTHER = "other-co";

function member(uid: string, role: "owner" | "admin" | "staff", tenantId = TENANT) {
  return {
    uid,
    claims: { email: `${uid}@acme.test`, tenantId, role, email_verified: true },
  };
}

const owner = member("u_owner", "owner");
const coOwner = member("u_owner2", "owner");
const admin = member("u_admin", "admin");
const staff = member("u_staff", "staff");
const outsider = member("u_outsider", "staff", OTHER);
registerMembers(owner, coOwner, admin, staff, outsider);

// The Auth side as onSignup / onAcceptInvite leave it: tenant claims set and a
// users/{uid} doc pointing at the business.
async function seedPeople(): Promise<void> {
  for (const m of [owner, coOwner, admin, staff, outsider]) {
    await createAuthUser({ uid: m.uid, email: m.claims.email, emailVerified: true });
    await testAuth.setCustomUserClaims(m.uid, {
      tenantId: m.claims.tenantId,
      role: m.claims.role,
    });
    await testDb.doc(`users/${m.uid}`).set({
      uid: m.uid,
      email: m.claims.email,
      displayName: m.uid === "u_admin" ? "Ada Admin" : null,
      defaultTenantId: m.claims.tenantId,
    });
  }
}

function membership(uid: string, tenantId = TENANT) {
  return testDb.doc(`userTenantMemberships/${uid}_${tenantId}`);
}

beforeEach(async () => {
  await clearFirestore();
  await clearAuthUsers();
  await seedPeople();
});

describe("removeMember (D21)", () => {
  it("marks the membership deleted, clears the tenant claims, and revokes refresh tokens", async () => {
    const before = Date.now();
    await expect(
      removeMemberHandler(fakeRequest({ targetUid: "u_staff" }, owner)),
    ).resolves.toEqual({ ok: true });

    const m = (await membership("u_staff").get()).data();
    expect(m?.deletedAt).toBeTruthy();
    expect(m?.deletedBy).toBe("u_owner");
    expect(m?.role).toBe("staff");

    const user = await testAuth.getUser("u_staff");
    expect(user.customClaims ?? {}).not.toHaveProperty("tenantId");
    expect(user.customClaims ?? {}).not.toHaveProperty("role");
    expect(user.tokensValidAfterTime).toBeTruthy();
    expect(new Date(user.tokensValidAfterTime!).getTime()).toBeGreaterThanOrEqual(
      Math.floor(before / 1000) * 1000,
    );

    expect((await testDb.doc("users/u_staff").get()).data()?.defaultTenantId).toBeNull();
  });

  it("the removed member's next call fails, though their old token still has the tenant claim", async () => {
    // Works before the removal…
    await upsertCustomerHandler(
      fakeRequest({ name: "Jane", email: "jane@example.com" }, staff),
    );
    await removeMemberHandler(fakeRequest({ targetUid: "u_staff" }, owner));

    // …and is refused after it, with the same (pre-removal) claims.
    await expect(
      upsertCustomerHandler(
        fakeRequest({ name: "Mallory", email: "m@example.com" }, staff),
      ),
    ).rejects.toMatchObject({ code: "permission-denied", message: REMOVED_MEMBER_MESSAGE });
    await expect(listMembersHandler(fakeRequest({}, staff))).rejects.toMatchObject({
      code: "permission-denied",
    });
    const customers = await testDb.collection(`tenants/${TENANT}/customers`).get();
    expect(customers.docs.map((d) => d.data().name)).toEqual(["Jane"]);
  });

  it("an owner can remove an admin", async () => {
    await removeMemberHandler(fakeRequest({ targetUid: "u_admin" }, owner));
    expect((await membership("u_admin").get()).data()?.deletedAt).toBeTruthy();
    await expect(
      upsertCustomerHandler(fakeRequest({ name: "X", email: "x@example.com" }, admin)),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("an owner can't remove themselves", async () => {
    await expect(
      removeMemberHandler(fakeRequest({ targetUid: "u_owner" }, owner)),
    ).rejects.toMatchObject({ code: "failed-precondition" });
    expect((await membership("u_owner").get()).data()?.deletedAt).toBeNull();
    expect((await testAuth.getUser("u_owner")).customClaims).toMatchObject({
      tenantId: TENANT,
      role: "owner",
    });
  });

  it("no owner can be removed, so the business always keeps one", async () => {
    await expect(
      removeMemberHandler(fakeRequest({ targetUid: "u_owner2" }, owner)),
    ).rejects.toMatchObject({
      code: "failed-precondition",
      message: expect.stringMatching(/Owners can't be removed/),
    });
    expect((await membership("u_owner2").get()).data()?.deletedAt).toBeNull();
    expect((await testAuth.getUser("u_owner2")).customClaims).toMatchObject({
      tenantId: TENANT,
    });
  });

  it.each([
    ["admin", admin],
    ["staff", staff],
  ])("%s can't remove anyone", async (_role, caller) => {
    const target = caller.uid === "u_staff" ? "u_admin" : "u_staff";
    await expect(
      removeMemberHandler(fakeRequest({ targetUid: target }, caller)),
    ).rejects.toMatchObject({ code: "permission-denied" });
    expect((await membership(target).get()).data()?.deletedAt).toBeNull();
  });

  it("refuses someone who isn't on this business's team", async () => {
    await expect(
      removeMemberHandler(fakeRequest({ targetUid: "u_outsider" }, owner)),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      removeMemberHandler(fakeRequest({ targetUid: "u_nobody" }, owner)),
    ).rejects.toMatchObject({ code: "not-found" });
    expect((await membership("u_outsider", OTHER).get()).data()?.deletedAt).toBeNull();
  });

  it("needs a valid targetUid", async () => {
    for (const targetUid of [undefined, "", "a/b"]) {
      await expect(
        removeMemberHandler(fakeRequest({ targetUid }, owner)),
      ).rejects.toMatchObject({ code: "invalid-argument" });
    }
  });

  it("a repeat call finishes a removal whose claims step didn't happen", async () => {
    await membership("u_staff").update({ deletedAt: new Date(), deletedBy: "u_owner" });
    await expect(
      removeMemberHandler(fakeRequest({ targetUid: "u_staff" }, owner)),
    ).resolves.toEqual({ ok: true });
    expect((await testAuth.getUser("u_staff")).customClaims ?? {}).not.toHaveProperty(
      "tenantId",
    );
  });

  it("keeps the removed person's other claims", async () => {
    await testAuth.setCustomUserClaims("u_staff", {
      tenantId: TENANT,
      role: "staff",
      platformAdmin: true,
    });
    await removeMemberHandler(fakeRequest({ targetUid: "u_staff" }, owner));
    expect((await testAuth.getUser("u_staff")).customClaims).toEqual({ platformAdmin: true });
  });

  it("a removed member can start their own business", async () => {
    await removeMemberHandler(fakeRequest({ targetUid: "u_staff" }, owner));
    const { tenantId } = await onSignupHandler(
      fakeRequest(
        { businessName: "Staff Startup" },
        { uid: "u_staff", claims: { email: staff.claims.email } },
      ),
    );
    expect(tenantId).toBe("staff-startup");
    expect((await membership("u_staff", tenantId).get()).data()?.role).toBe("owner");
  });
});

describe("requireTenant needs an active membership (D21)", () => {
  it("refuses tenant claims whose membership was deleted outright", async () => {
    await membership("u_admin").delete();
    await expect(
      upsertCustomerHandler(fakeRequest({ name: "X", email: "x@example.com" }, admin)),
    ).rejects.toMatchObject({ code: "permission-denied", message: REMOVED_MEMBER_MESSAGE });
  });

  it("checks the verified email first (F-02)", async () => {
    await membership("u_admin").delete();
    await expect(
      upsertCustomerHandler(
        fakeRequest(
          { name: "X", email: "x@example.com" },
          { uid: "u_admin", claims: { ...admin.claims, email_verified: false } },
        ),
      ),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });
});

describe("listMembers (D21)", () => {
  it("lists the active team, owners first, with email and name", async () => {
    await removeMemberHandler(fakeRequest({ targetUid: "u_staff" }, owner));
    const { members } = await listMembersHandler(fakeRequest({}, admin));
    expect(members.map((m) => [m.uid, m.role, m.email])).toEqual([
      ["u_owner", "owner", "u_owner@acme.test"],
      ["u_owner2", "owner", "u_owner2@acme.test"],
      ["u_admin", "admin", "u_admin@acme.test"],
    ]);
    expect(members.find((m) => m.uid === "u_admin")?.displayName).toBe("Ada Admin");
    expect(typeof members[0].joinedAt).toBe("number");
  });

  it("any role can see the team, and only its own business's", async () => {
    const { members } = await listMembersHandler(fakeRequest({}, outsider));
    expect(members.map((m) => m.uid)).toEqual(["u_outsider"]);
  });
});
