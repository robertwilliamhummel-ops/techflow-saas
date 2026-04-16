import { beforeEach, describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  clearAuthUsers,
  clearFirestore,
  createAuthUser,
  fakeRequest,
  testAuth,
  testDb,
} from "./_setup";
import { onAcceptInviteHandler } from "../../src/tenants/onAcceptInvite";
import { hashToken } from "../../src/shared/tokens";

interface InviteFixture {
  tenantId: string;
  invitationId: string;
  rawToken: string;
}

async function seedInvite(
  opts: {
    email?: string;
    role?: "admin" | "staff";
    expiresInMs?: number;
    acceptedAt?: Timestamp | null;
    revokedAt?: Timestamp | null;
  } = {},
): Promise<InviteFixture> {
  const tenantId = "acme";
  const invitationId = "inv_abc";
  const rawToken = "super-secret-opaque-token";
  await testDb.doc(`tenants/${tenantId}/meta/settings`).set({
    name: "Acme",
    createdAt: new Date(),
  });
  await testDb.doc(`tenants/${tenantId}/invitations/${invitationId}`).set({
    tenantId,
    email: opts.email ?? "invitee@acme.test",
    role: opts.role ?? "staff",
    tokenHash: hashToken(rawToken),
    invitedBy: "owner1",
    createdAt: new Date(),
    expiresAt: Timestamp.fromMillis(
      Date.now() + (opts.expiresInMs ?? 7 * 24 * 60 * 60 * 1000),
    ),
    acceptedAt: opts.acceptedAt ?? null,
    revokedAt: opts.revokedAt ?? null,
  });
  return { tenantId, invitationId, rawToken };
}

async function seedInvitee(
  uid: string,
  email: string,
  emailVerified = true,
): Promise<void> {
  await createAuthUser({ uid, email, emailVerified });
}

describe("onAcceptInvite", () => {
  beforeEach(async () => {
    await clearFirestore();
    await clearAuthUsers();
  });

  it("happy path — marks invitation accepted, creates membership + user, sets claims", async () => {
    const { tenantId, invitationId, rawToken } = await seedInvite({
      email: "newstaff@acme.test",
      role: "staff",
    });
    await seedInvitee("u_new", "newstaff@acme.test");

    const res = await onAcceptInviteHandler(
      fakeRequest(
        { tenantId, invitationId, token: rawToken },
        {
          uid: "u_new",
          claims: {
            email: "newstaff@acme.test",
            email_verified: true,
          },
        },
      ),
    );
    expect(res).toEqual({ tenantId, role: "staff" });

    const inv = await testDb
      .doc(`tenants/${tenantId}/invitations/${invitationId}`)
      .get();
    expect(inv.data()?.acceptedAt).toBeDefined();
    expect(inv.data()?.acceptedBy).toBe("u_new");

    const membership = await testDb
      .doc(`userTenantMemberships/u_new_${tenantId}`)
      .get();
    expect(membership.data()?.role).toBe("staff");
    expect(membership.data()?.invitedBy).toBe("owner1");

    const user = await testDb.doc("users/u_new").get();
    expect(user.data()?.email).toBe("newstaff@acme.test");
    expect(user.data()?.defaultTenantId).toBe(tenantId);

    const claims = (await testAuth.getUser("u_new")).customClaims;
    expect(claims?.tenantId).toBe(tenantId);
    expect(claims?.role).toBe("staff");
  });

  it("rejects when invitee's email is not verified", async () => {
    const { tenantId, invitationId, rawToken } = await seedInvite();
    await seedInvitee("u_unverified", "invitee@acme.test", false);

    await expect(
      onAcceptInviteHandler(
        fakeRequest(
          { tenantId, invitationId, token: rawToken },
          {
            uid: "u_unverified",
            claims: { email: "invitee@acme.test", email_verified: false },
          },
        ),
      ),
    ).rejects.toThrow(/Verify your email/);
  });

  it("rejects when caller already belongs to a tenant (MVP single-tenant)", async () => {
    const { tenantId, invitationId, rawToken } = await seedInvite();
    await seedInvitee("u_existing", "invitee@acme.test");

    await expect(
      onAcceptInviteHandler(
        fakeRequest(
          { tenantId, invitationId, token: rawToken },
          {
            uid: "u_existing",
            claims: {
              email: "invitee@acme.test",
              email_verified: true,
              tenantId: "other-tenant",
              role: "staff",
            },
          },
        ),
      ),
    ).rejects.toThrow(/already belongs to a tenant/);
  });

  it("rejects when token is wrong", async () => {
    const { tenantId, invitationId } = await seedInvite();
    await seedInvitee("u1", "invitee@acme.test");
    await expect(
      onAcceptInviteHandler(
        fakeRequest(
          { tenantId, invitationId, token: "wrong-token" },
          {
            uid: "u1",
            claims: { email: "invitee@acme.test", email_verified: true },
          },
        ),
      ),
    ).rejects.toThrow(/Invalid invitation token/);
  });

  it("rejects when caller email does not match the invite", async () => {
    const { tenantId, invitationId, rawToken } = await seedInvite({
      email: "intended@acme.test",
    });
    await seedInvitee("u_other", "someoneelse@acme.test");
    await expect(
      onAcceptInviteHandler(
        fakeRequest(
          { tenantId, invitationId, token: rawToken },
          {
            uid: "u_other",
            claims: {
              email: "someoneelse@acme.test",
              email_verified: true,
            },
          },
        ),
      ),
    ).rejects.toThrow(/different email address/);
  });

  it("rejects expired invite", async () => {
    const { tenantId, invitationId, rawToken } = await seedInvite({
      expiresInMs: -1000,
    });
    await seedInvitee("u_late", "invitee@acme.test");
    await expect(
      onAcceptInviteHandler(
        fakeRequest(
          { tenantId, invitationId, token: rawToken },
          {
            uid: "u_late",
            claims: { email: "invitee@acme.test", email_verified: true },
          },
        ),
      ),
    ).rejects.toThrow(/expired/);
  });

  it("rejects already-accepted invite (second racer loses)", async () => {
    const { tenantId, invitationId, rawToken } = await seedInvite({
      acceptedAt: Timestamp.now(),
    });
    await seedInvitee("u_second", "invitee@acme.test");
    await expect(
      onAcceptInviteHandler(
        fakeRequest(
          { tenantId, invitationId, token: rawToken },
          {
            uid: "u_second",
            claims: { email: "invitee@acme.test", email_verified: true },
          },
        ),
      ),
    ).rejects.toThrow(/already been accepted/);
  });

  it("rejects revoked invite", async () => {
    const { tenantId, invitationId, rawToken } = await seedInvite({
      revokedAt: Timestamp.now(),
    });
    await seedInvitee("u_rev", "invitee@acme.test");
    await expect(
      onAcceptInviteHandler(
        fakeRequest(
          { tenantId, invitationId, token: rawToken },
          {
            uid: "u_rev",
            claims: { email: "invitee@acme.test", email_verified: true },
          },
        ),
      ),
    ).rejects.toThrow(/revoked/);
  });

  it("rejects missing required args", async () => {
    await seedInvitee("u1", "i@x.test");
    await expect(
      onAcceptInviteHandler(
        fakeRequest(
          { tenantId: "", invitationId: "", token: "" },
          { uid: "u1", claims: { email: "i@x.test", email_verified: true } },
        ),
      ),
    ).rejects.toThrow(/are all required/);
  });

  it("rejects unknown invitation", async () => {
    await seedInvitee("u1", "i@x.test");
    await expect(
      onAcceptInviteHandler(
        fakeRequest(
          { tenantId: "ghost", invitationId: "ghost", token: "x" },
          { uid: "u1", claims: { email: "i@x.test", email_verified: true } },
        ),
      ),
    ).rejects.toThrow(/not found/);
  });
});
