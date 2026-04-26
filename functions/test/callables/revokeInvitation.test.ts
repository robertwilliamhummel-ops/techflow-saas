import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  clearAuthUsers,
  clearFirestore,
  fakeRequest,
  testDb,
} from "./_setup";

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { revokeInvitationHandler } from "../../src/tenants/revokeInvitation";

const TENANT = "acme";

async function seedInvite(
  opts: {
    invitationId?: string;
    acceptedAt?: Timestamp | null;
    revokedAt?: Timestamp | null;
  } = {},
): Promise<string> {
  const id = opts.invitationId ?? "inv_abc";
  await testDb.doc(`tenants/${TENANT}/invitations/${id}`).set({
    tenantId: TENANT,
    email: "staff@acme.test",
    role: "staff",
    tokenHash: "x".repeat(64),
    invitedBy: "owner1",
    createdAt: new Date(),
    expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000),
    acceptedAt: opts.acceptedAt ?? null,
    revokedAt: opts.revokedAt ?? null,
  });
  return id;
}

describe("revokeInvitation", () => {
  beforeEach(async () => {
    await clearFirestore();
    await clearAuthUsers();
  });

  it("owner stamps revokedAt + revokedBy", async () => {
    const id = await seedInvite();
    await revokeInvitationHandler(
      fakeRequest(
        { invitationId: id },
        { uid: "owner1", claims: { tenantId: TENANT, role: "owner" } },
      ),
    );
    const snap = await testDb
      .doc(`tenants/${TENANT}/invitations/${id}`)
      .get();
    const data = snap.data();
    expect(data?.revokedAt).toBeDefined();
    expect(data?.revokedBy).toBe("owner1");
  });

  it("admin can also revoke", async () => {
    const id = await seedInvite();
    await revokeInvitationHandler(
      fakeRequest(
        { invitationId: id },
        { uid: "admin1", claims: { tenantId: TENANT, role: "admin" } },
      ),
    );
    const data = (
      await testDb.doc(`tenants/${TENANT}/invitations/${id}`).get()
    ).data();
    expect(data?.revokedAt).toBeDefined();
  });

  it("rejects staff role", async () => {
    const id = await seedInvite();
    await expect(
      revokeInvitationHandler(
        fakeRequest(
          { invitationId: id },
          { uid: "staff1", claims: { tenantId: TENANT, role: "staff" } },
        ),
      ),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("rejects when invitation does not exist", async () => {
    await expect(
      revokeInvitationHandler(
        fakeRequest(
          { invitationId: "nope" },
          { uid: "owner1", claims: { tenantId: TENANT, role: "owner" } },
        ),
      ),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("rejects already-accepted invitations", async () => {
    const id = await seedInvite({ acceptedAt: Timestamp.now() });
    await expect(
      revokeInvitationHandler(
        fakeRequest(
          { invitationId: id },
          { uid: "owner1", claims: { tenantId: TENANT, role: "owner" } },
        ),
      ),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("rejects double-revoke", async () => {
    const id = await seedInvite({ revokedAt: Timestamp.now() });
    await expect(
      revokeInvitationHandler(
        fakeRequest(
          { invitationId: id },
          { uid: "owner1", claims: { tenantId: TENANT, role: "owner" } },
        ),
      ),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("rejects missing invitationId", async () => {
    await expect(
      revokeInvitationHandler(
        fakeRequest(
          {},
          { uid: "owner1", claims: { tenantId: TENANT, role: "owner" } },
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });
});
