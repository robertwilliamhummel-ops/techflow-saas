import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAuthUsers,
  clearFirestore,
  createAuthUser,
  fakeRequest,
  testDb,
} from "./_setup";

// Mock the email send layer — callable tests verify Firestore state, not
// Resend delivery. The send.test.ts suite covers the real send path.
vi.mock("../../src/emails/send", () => ({
  sendInvitationEmail: vi.fn().mockResolvedValue(undefined),
}));

import { createInvitationHandler } from "../../src/tenants/createInvitation";
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

describe("createInvitation", () => {
  beforeEach(async () => {
    await clearFirestore();
    await clearAuthUsers();
  });

  it("owner creates invitation — stored with hashed token + expiry", async () => {
    const tenantId = await seedOwner();

    const { invitationId } = await createInvitationHandler(
      fakeRequest(
        { email: "staff@acme.test", role: "staff" },
        { uid: "owner1", claims: { tenantId, role: "owner" } },
      ),
    );

    const snap = await testDb
      .doc(`tenants/${tenantId}/invitations/${invitationId}`)
      .get();
    expect(snap.exists).toBe(true);
    const data = snap.data();
    expect(data?.email).toBe("staff@acme.test");
    expect(data?.role).toBe("staff");
    expect(data?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data?.acceptedAt).toBeNull();
    expect(data?.revokedAt).toBeNull();
    expect(data?.invitedBy).toBe("owner1");
    const expires = data?.expiresAt.toMillis();
    expect(expires).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect(expires).toBeLessThan(Date.now() + 8 * 24 * 60 * 60 * 1000);
  });

  it("lowercases email at write boundary", async () => {
    const tenantId = await seedOwner();
    const { invitationId } = await createInvitationHandler(
      fakeRequest(
        { email: "Staff@ACME.Test", role: "admin" },
        { uid: "owner1", claims: { tenantId, role: "owner" } },
      ),
    );
    const snap = await testDb
      .doc(`tenants/${tenantId}/invitations/${invitationId}`)
      .get();
    expect(snap.data()?.email).toBe("staff@acme.test");
  });

  it("rejects when caller has no tenant", async () => {
    await createAuthUser({ uid: "loner", email: "l@x.test" });
    await expect(
      createInvitationHandler(
        fakeRequest(
          { email: "a@b.test", role: "staff" },
          { uid: "loner" },
        ),
      ),
    ).rejects.toThrow(/Tenant membership required/);
  });

  it("rejects when caller is staff, not owner/admin", async () => {
    const tenantId = await seedOwner();
    await expect(
      createInvitationHandler(
        fakeRequest(
          { email: "x@y.test", role: "staff" },
          { uid: "intruder", claims: { tenantId, role: "staff" } },
        ),
      ),
    ).rejects.toThrow(/Requires one of: owner, admin/);
  });

  it("rejects role=owner (owners only via onSignup)", async () => {
    const tenantId = await seedOwner();
    await expect(
      createInvitationHandler(
        fakeRequest(
          { email: "new@acme.test", role: "owner" },
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/role must be one of: admin, staff/);
  });

  it("rejects invalid email format", async () => {
    const tenantId = await seedOwner();
    await expect(
      createInvitationHandler(
        fakeRequest(
          { email: "not-an-email", role: "staff" },
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/not a valid address/);
  });

  it("rejects duplicate pending invite for same email", async () => {
    const tenantId = await seedOwner();
    await createInvitationHandler(
      fakeRequest(
        { email: "dup@acme.test", role: "staff" },
        { uid: "owner1", claims: { tenantId, role: "owner" } },
      ),
    );
    await expect(
      createInvitationHandler(
        fakeRequest(
          { email: "dup@acme.test", role: "admin" },
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/unaccepted invitation already exists/);
  });
});
