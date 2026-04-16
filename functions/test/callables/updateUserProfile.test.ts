import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAuthUsers,
  clearFirestore,
  createAuthUser,
  fakeRequest,
  testDb,
} from "./_setup";
import { updateUserProfileHandler } from "../../src/tenants/updateUserProfile";

describe("updateUserProfile", () => {
  beforeEach(async () => {
    await clearFirestore();
    await clearAuthUsers();
    await createAuthUser({ uid: "u1", email: "u1@x.test" });
    await testDb.doc("users/u1").set({
      uid: "u1",
      email: "u1@x.test",
      displayName: null,
      createdAt: new Date(),
    });
  });

  it("updates displayName", async () => {
    const res = await updateUserProfileHandler(
      fakeRequest(
        { displayName: "Robert Hummel" },
        { uid: "u1", claims: { email: "u1@x.test" } },
      ),
    );
    expect(res).toEqual({ ok: true });

    const snap = await testDb.doc("users/u1").get();
    expect(snap.data()?.displayName).toBe("Robert Hummel");
  });

  it("accepts explicit null to clear displayName", async () => {
    await updateUserProfileHandler(
      fakeRequest(
        { displayName: "Seed" },
        { uid: "u1", claims: { email: "u1@x.test" } },
      ),
    );
    await updateUserProfileHandler(
      fakeRequest(
        { displayName: null },
        { uid: "u1", claims: { email: "u1@x.test" } },
      ),
    );
    const snap = await testDb.doc("users/u1").get();
    expect(snap.data()?.displayName).toBeNull();
  });

  it("rejects empty string", async () => {
    await expect(
      updateUserProfileHandler(
        fakeRequest(
          { displayName: "   " },
          { uid: "u1", claims: { email: "u1@x.test" } },
        ),
      ),
    ).rejects.toThrow(/1–80 characters/);
  });

  it("rejects overly long name", async () => {
    await expect(
      updateUserProfileHandler(
        fakeRequest(
          { displayName: "x".repeat(81) },
          { uid: "u1", claims: { email: "u1@x.test" } },
        ),
      ),
    ).rejects.toThrow(/1–80 characters/);
  });

  it("rejects when no editable fields provided", async () => {
    await expect(
      updateUserProfileHandler(
        fakeRequest({}, { uid: "u1", claims: { email: "u1@x.test" } }),
      ),
    ).rejects.toThrow(/No editable fields/);
  });

  it("rejects when unauthenticated", async () => {
    await expect(
      updateUserProfileHandler(
        fakeRequest({ displayName: "X" }, null),
      ),
    ).rejects.toThrow(/Sign in required/);
  });

  it("ignores unknown fields (no tenantId or role spoof)", async () => {
    await updateUserProfileHandler(
      fakeRequest(
        { displayName: "Valid", tenantId: "evil", role: "owner" } as never,
        { uid: "u1", claims: { email: "u1@x.test" } },
      ),
    );
    const snap = await testDb.doc("users/u1").get();
    expect(snap.data()?.tenantId).toBeUndefined();
    expect(snap.data()?.role).toBeUndefined();
    expect(snap.data()?.displayName).toBe("Valid");
  });
});
