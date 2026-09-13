// A-10 — upsertCustomer + deleteCustomer. Rules block client writes to
// customers, so these callables are the only way to manage the records.

import { beforeEach, describe, expect, it } from "vitest";
import { clearFirestore, fakeRequest, testDb } from "./_setup";
import { upsertCustomerHandler } from "../../src/customers/upsertCustomer";
import { deleteCustomerHandler } from "../../src/customers/deleteCustomer";

const TENANT = "acme-plumbing";

function member(role: "owner" | "admin" | "staff", tenantId = TENANT) {
  return {
    uid: `u_${role}_${tenantId}`,
    claims: { email: `${role}@acme.test`, tenantId, role },
  };
}

const jane = {
  name: "  Jane Doe ",
  email: " JANE@Example.com ",
  phone: "555-1234",
  address: "1 King St W, Toronto",
  notes: "Side door",
};

function customerRef(id: string, tenantId = TENANT) {
  return testDb.doc(`tenants/${tenantId}/customers/${id}`);
}

describe("upsertCustomer", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("rejects unauthenticated calls", async () => {
    await expect(
      upsertCustomerHandler(fakeRequest(jane, null)),
    ).rejects.toThrow(/sign in required/i);
  });

  it("rejects callers without a tenant", async () => {
    await expect(
      upsertCustomerHandler(
        fakeRequest(jane, { uid: "u1", claims: { email: "a@b.test" } }),
      ),
    ).rejects.toThrow(/tenant membership required/i);
  });

  it("creates a customer, trimming fields and lowercasing the email", async () => {
    const res = await upsertCustomerHandler(fakeRequest(jane, member("owner")));
    expect(res.created).toBe(true);

    const data = (await customerRef(res.customerId).get()).data()!;
    expect(data).toMatchObject({
      name: "Jane Doe",
      email: "jane@example.com",
      phone: "555-1234",
      address: "1 King St W, Toronto",
      notes: "Side door",
      createdBy: "u_owner_acme-plumbing",
      updatedAt: null,
      updatedBy: null,
    });
    expect(data.createdAt).toBeTruthy();
  });

  it("lets staff create customers and stores blank optional fields as null", async () => {
    const res = await upsertCustomerHandler(
      fakeRequest(
        { name: "Bob", email: "bob@example.com", phone: "  ", notes: null },
        member("staff"),
      ),
    );
    const data = (await customerRef(res.customerId).get()).data()!;
    expect(data.phone).toBeNull();
    expect(data.address).toBeNull();
    expect(data.notes).toBeNull();
    expect(data.createdBy).toBe("u_staff_acme-plumbing");
  });

  it("allows two customers with the same email", async () => {
    const a = await upsertCustomerHandler(
      fakeRequest({ ...jane, name: "Building A" }, member("owner")),
    );
    const b = await upsertCustomerHandler(
      fakeRequest({ ...jane, name: "Building B" }, member("owner")),
    );
    expect(a.customerId).not.toBe(b.customerId);
    const all = await testDb.collection(`tenants/${TENANT}/customers`).get();
    expect(all.size).toBe(2);
  });

  it("updates an existing customer and keeps who created it", async () => {
    const { customerId } = await upsertCustomerHandler(
      fakeRequest(jane, member("owner")),
    );
    const before = (await customerRef(customerId).get()).data()!;

    const res = await upsertCustomerHandler(
      fakeRequest(
        { customerId, name: "Jane Smith", email: "jane.smith@example.com" },
        member("staff"),
      ),
    );
    expect(res).toEqual({ customerId, created: false });

    const after = (await customerRef(customerId).get()).data()!;
    expect(after.name).toBe("Jane Smith");
    expect(after.email).toBe("jane.smith@example.com");
    expect(after.phone).toBeNull(); // full replace of the editable fields
    expect(after.createdBy).toBe("u_owner_acme-plumbing");
    expect(after.createdAt.isEqual(before.createdAt)).toBe(true);
    expect(after.updatedBy).toBe("u_staff_acme-plumbing");
    expect(after.updatedAt).toBeTruthy();
  });

  it("answers not-found for an unknown customerId without creating it", async () => {
    await expect(
      upsertCustomerHandler(
        fakeRequest({ ...jane, customerId: "missing" }, member("owner")),
      ),
    ).rejects.toThrow(/customer not found/i);
    expect((await customerRef("missing").get()).exists).toBe(false);
  });

  it("can't update another tenant's customer", async () => {
    const { customerId } = await upsertCustomerHandler(
      fakeRequest(jane, member("owner")),
    );

    await expect(
      upsertCustomerHandler(
        fakeRequest(
          { customerId, name: "Hijacked", email: "evil@example.com" },
          member("owner", "other-tenant"),
        ),
      ),
    ).rejects.toThrow(/customer not found/i);

    expect((await customerRef(customerId).get()).data()!.name).toBe("Jane Doe");
    expect((await customerRef(customerId, "other-tenant").get()).exists).toBe(
      false,
    );
  });

  it.each([
    ["a blank name", { ...jane, name: "   " }, /name must be 1–200/],
    ["a 201-character name", { ...jane, name: "x".repeat(201) }, /name must be 1–200/],
    ["an invalid email", { ...jane, email: "not-an-email" }, /valid email/],
    ["a missing email", { ...jane, email: undefined }, /valid email/],
    ["a 51-character phone", { ...jane, phone: "5".repeat(51) }, /phone must be ≤50/],
    ["a 501-character address", { ...jane, address: "x".repeat(501) }, /address must be ≤500/],
    ["2001-character notes", { ...jane, notes: "x".repeat(2001) }, /notes must be ≤2000/],
  ])("rejects %s", async (_label, input, message) => {
    await expect(
      upsertCustomerHandler(fakeRequest(input, member("owner"))),
    ).rejects.toThrow(message);
  });

  it.each(["a/b", "..", "__id__", "x".repeat(129), ""])(
    "rejects customerId %j",
    async (customerId) => {
      await expect(
        upsertCustomerHandler(
          fakeRequest({ ...jane, customerId }, member("owner")),
        ),
      ).rejects.toThrow(/customerId (required|is invalid)/);
    },
  );

  it("ignores fields callers can't set", async () => {
    const { customerId } = await upsertCustomerHandler(
      fakeRequest(
        { ...jane, tenantId: "evil", createdBy: "someone-else" } as never,
        member("owner"),
      ),
    );
    const data = (await customerRef(customerId).get()).data()!;
    expect(data.tenantId).toBeUndefined();
    expect(data.createdBy).toBe("u_owner_acme-plumbing");
  });
});

describe("deleteCustomer", () => {
  let customerId: string;

  beforeEach(async () => {
    await clearFirestore();
    ({ customerId } = await upsertCustomerHandler(
      fakeRequest(jane, member("owner")),
    ));
  });

  it("rejects staff", async () => {
    await expect(
      deleteCustomerHandler(fakeRequest({ customerId }, member("staff"))),
    ).rejects.toThrow(/requires one of/i);
    expect((await customerRef(customerId).get()).exists).toBe(true);
  });

  it.each(["owner", "admin"] as const)("lets an %s delete", async (role) => {
    const res = await deleteCustomerHandler(
      fakeRequest({ customerId }, member(role)),
    );
    expect(res).toEqual({ deleted: true });
    expect((await customerRef(customerId).get()).exists).toBe(false);
  });

  it("answers not-found for an unknown customer", async () => {
    await expect(
      deleteCustomerHandler(
        fakeRequest({ customerId: "missing" }, member("owner")),
      ),
    ).rejects.toThrow(/customer not found/i);
  });

  it("requires a valid customerId", async () => {
    await expect(
      deleteCustomerHandler(fakeRequest({}, member("owner"))),
    ).rejects.toThrow(/customerId required/);
    await expect(
      deleteCustomerHandler(
        fakeRequest({ customerId: `${customerId}/x/y` }, member("owner")),
      ),
    ).rejects.toThrow(/customerId is invalid/);
  });

  it("can't delete another tenant's customer", async () => {
    await expect(
      deleteCustomerHandler(
        fakeRequest({ customerId }, member("owner", "other-tenant")),
      ),
    ).rejects.toThrow(/customer not found/i);
    expect((await customerRef(customerId).get()).exists).toBe(true);
  });
});
