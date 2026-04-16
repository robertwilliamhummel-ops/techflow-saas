import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAuthUsers,
  clearFirestore,
  createAuthUser,
  fakeRequest,
  testDb,
} from "./_setup";
import { updateTenantBrandingHandler } from "../../src/tenants/updateTenantBranding";
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

describe("updateTenantBranding", () => {
  beforeEach(async () => {
    await clearFirestore();
    await clearAuthUsers();
  });

  it("owner updates multiple whitelisted fields", async () => {
    const tenantId = await seedOwner();

    const res = await updateTenantBrandingHandler(
      fakeRequest(
        {
          name: "Acme Plumbing Ltd",
          address: "123 Main St, Toronto",
          primaryColor: "#0066CC",
          secondaryColor: "#333333",
          fontFamily: "Roboto",
          taxRate: 0.05,
          taxName: "GST",
          currency: "USD",
          invoicePrefix: "ACME",
        },
        { uid: "owner1", claims: { tenantId, role: "owner" } },
      ),
    );
    expect(res).toEqual({ ok: true });

    const meta = await testDb.doc(`tenants/${tenantId}/meta/settings`).get();
    const data = meta.data();
    expect(data?.name).toBe("Acme Plumbing Ltd");
    expect(data?.address).toBe("123 Main St, Toronto");
    expect(data?.primaryColor).toBe("#0066CC");
    expect(data?.secondaryColor).toBe("#333333");
    expect(data?.fontFamily).toBe("Roboto");
    expect(data?.taxRate).toBe(0.05);
    expect(data?.taxName).toBe("GST");
    expect(data?.currency).toBe("USD");
    expect(data?.invoicePrefix).toBe("ACME");
  });

  it("admin can update branding", async () => {
    const tenantId = await seedOwner();
    const res = await updateTenantBrandingHandler(
      fakeRequest(
        { name: "Renamed Co" },
        { uid: "adminUser", claims: { tenantId, role: "admin" } },
      ),
    );
    expect(res).toEqual({ ok: true });
  });

  it("rejects staff caller", async () => {
    const tenantId = await seedOwner();
    await expect(
      updateTenantBrandingHandler(
        fakeRequest(
          { name: "Hacked" },
          { uid: "staffUser", claims: { tenantId, role: "staff" } },
        ),
      ),
    ).rejects.toThrow(/Requires one of: owner, admin/);
  });

  it("rejects caller without tenant", async () => {
    await seedOwner();
    await expect(
      updateTenantBrandingHandler(
        fakeRequest({ name: "X" }, { uid: "loner" }),
      ),
    ).rejects.toThrow(/Tenant membership required/);
  });

  it("rejects primaryColor that fails WCAG AA vs white", async () => {
    const tenantId = await seedOwner();
    await expect(
      updateTenantBrandingHandler(
        fakeRequest(
          { primaryColor: "#FFFF00" },
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/WCAG AA contrast/);
  });

  it("rejects invalid hex format", async () => {
    const tenantId = await seedOwner();
    await expect(
      updateTenantBrandingHandler(
        fakeRequest(
          { primaryColor: "not-a-color" },
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/hex color/);
  });

  it("rejects taxRate out of range", async () => {
    const tenantId = await seedOwner();
    await expect(
      updateTenantBrandingHandler(
        fakeRequest(
          { taxRate: 1.5 },
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/between 0 and 1/);
  });

  it("rejects name too short", async () => {
    const tenantId = await seedOwner();
    await expect(
      updateTenantBrandingHandler(
        fakeRequest(
          { name: "X" },
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/2–100 characters/);
  });

  it("rejects non-https logoUrl", async () => {
    const tenantId = await seedOwner();
    await expect(
      updateTenantBrandingHandler(
        fakeRequest(
          { logoUrl: "http://insecure.example.com/logo.png" },
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/valid https URL/);
  });

  it("accepts null to clear logoUrl", async () => {
    const tenantId = await seedOwner();
    await updateTenantBrandingHandler(
      fakeRequest(
        { logoUrl: null },
        { uid: "owner1", claims: { tenantId, role: "owner" } },
      ),
    );
    const meta = await testDb.doc(`tenants/${tenantId}/meta/settings`).get();
    expect(meta.data()?.logoUrl).toBeNull();
  });

  it("rejects invalid invoicePrefix (lowercase)", async () => {
    const tenantId = await seedOwner();
    await expect(
      updateTenantBrandingHandler(
        fakeRequest(
          { invoicePrefix: "inv!" },
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/uppercase letters\/digits/);
  });

  it("rejects invalid currency", async () => {
    const tenantId = await seedOwner();
    await expect(
      updateTenantBrandingHandler(
        fakeRequest(
          { currency: "EUR" },
          { uid: "owner1", claims: { tenantId, role: "owner" } },
        ),
      ),
    ).rejects.toThrow(/CAD or USD/);
  });

  it("rejects when no editable fields supplied", async () => {
    const tenantId = await seedOwner();
    await expect(
      updateTenantBrandingHandler(
        fakeRequest({}, { uid: "owner1", claims: { tenantId, role: "owner" } }),
      ),
    ).rejects.toThrow(/No editable fields/);
  });

  it("ignores unknown fields (no etransferEmail or stripe spoof)", async () => {
    const tenantId = await seedOwner();
    await updateTenantBrandingHandler(
      fakeRequest(
        {
          name: "Legit Co",
          etransferEmail: "spoof@x.test",
          chargeCustomerCardFees: true,
          stripeAccountId: "acct_evil",
        } as never,
        { uid: "owner1", claims: { tenantId, role: "owner" } },
      ),
    );
    const meta = await testDb.doc(`tenants/${tenantId}/meta/settings`).get();
    expect(meta.data()?.etransferEmail).toBeNull();
    expect(meta.data()?.chargeCustomerCardFees).toBe(false);
    expect(meta.data()?.stripeAccountId).toBeNull();
    expect(meta.data()?.name).toBe("Legit Co");
  });
});
