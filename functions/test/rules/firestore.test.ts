import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { doc, getDoc, setDoc, Timestamp } from "firebase/firestore";

const PROJECT_ID = "techflow-rules-test";

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: "127.0.0.1",
      port: 8080,
      rules: readFileSync("../firestore.rules", "utf8"),
    },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

function authed(uid: string, claims: Record<string, unknown> = {}) {
  return env.authenticatedContext(uid, claims).firestore();
}

function unauthed() {
  return env.unauthenticatedContext().firestore();
}

describe("users/{uid}", () => {
  it("owner can read own doc", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users/alice"), { email: "a@x.com" });
    });
    await assertSucceeds(getDoc(doc(authed("alice"), "users/alice")));
  });

  it("other user cannot read another's doc", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users/alice"), { email: "a@x.com" });
    });
    await assertFails(getDoc(doc(authed("bob"), "users/alice")));
  });

  it("client cannot write users doc", async () => {
    await assertFails(
      setDoc(doc(authed("alice"), "users/alice"), { email: "a@x.com" }),
    );
  });
});

describe("userTenantMemberships/{uid}_{tenantId}", () => {
  it("user reads own membership by docId prefix", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "userTenantMemberships/alice_t1"), {
        uid: "alice",
        tenantId: "t1",
        role: "owner",
      });
    });
    await assertSucceeds(
      getDoc(doc(authed("alice"), "userTenantMemberships/alice_t1")),
    );
  });

  it("user cannot read another user's membership", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "userTenantMemberships/bob_t1"), {
        uid: "bob",
        tenantId: "t1",
        role: "owner",
      });
    });
    await assertFails(
      getDoc(doc(authed("alice"), "userTenantMemberships/bob_t1")),
    );
  });

  it("client cannot write memberships", async () => {
    await assertFails(
      setDoc(doc(authed("alice"), "userTenantMemberships/alice_t1"), {
        uid: "alice",
        tenantId: "t1",
        role: "owner",
      }),
    );
  });
});

describe("tenants/{tenantId}/meta", () => {
  it("member reads meta", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "tenants/t1/meta/settings"), {
        name: "Acme",
      });
    });
    await assertSucceeds(
      getDoc(doc(authed("alice", { tenantId: "t1" }), "tenants/t1/meta/settings")),
    );
  });

  it("non-member cannot read meta", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "tenants/t1/meta/settings"), {
        name: "Acme",
      });
    });
    await assertFails(
      getDoc(doc(authed("eve", { tenantId: "t2" }), "tenants/t1/meta/settings")),
    );
  });

  it("unauth cannot read meta", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "tenants/t1/meta/settings"), {
        name: "Acme",
      });
    });
    await assertFails(getDoc(doc(unauthed(), "tenants/t1/meta/settings")));
  });

  it("member cannot write meta", async () => {
    await assertFails(
      setDoc(
        doc(authed("alice", { tenantId: "t1" }), "tenants/t1/meta/settings"),
        { name: "Acme" },
      ),
    );
  });
});

describe("tenants/{tenantId}/invoices", () => {
  const invoicePath = "tenants/t1/invoices/inv1";
  const invoiceData = {
    customer: { email: "customer@example.com" },
    total: 100,
    createdAt: Timestamp.now(),
  };

  it("tenant member reads invoice", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), invoicePath), invoiceData);
    });
    await assertSucceeds(
      getDoc(doc(authed("alice", { tenantId: "t1" }), invoicePath)),
    );
  });

  it("verified customer matching email reads invoice", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), invoicePath), invoiceData);
    });
    await assertSucceeds(
      getDoc(
        doc(
          authed("cust1", { email: "customer@example.com", email_verified: true }),
          invoicePath,
        ),
      ),
    );
  });

  it("verified customer with CASE-DIFFERENT email still reads invoice (lowercase compare)", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), invoicePath), invoiceData);
    });
    await assertSucceeds(
      getDoc(
        doc(
          authed("cust1", { email: "CUSTOMER@Example.COM", email_verified: true }),
          invoicePath,
        ),
      ),
    );
  });

  it("unverified customer with matching email is denied", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), invoicePath), invoiceData);
    });
    await assertFails(
      getDoc(
        doc(
          authed("cust1", { email: "customer@example.com", email_verified: false }),
          invoicePath,
        ),
      ),
    );
  });

  it("customer with different email is denied", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), invoicePath), invoiceData);
    });
    await assertFails(
      getDoc(
        doc(
          authed("cust2", { email: "other@example.com", email_verified: true }),
          invoicePath,
        ),
      ),
    );
  });

  it("tenant member cannot write invoices (admin-SDK-only)", async () => {
    await assertFails(
      setDoc(
        doc(authed("alice", { tenantId: "t1" }), invoicePath),
        invoiceData,
      ),
    );
  });
});

describe("tenants/{tenantId}/quotes", () => {
  const quotePath = "tenants/t1/quotes/q1";
  const quoteData = {
    customer: { email: "customer@example.com" },
    total: 100,
    createdAt: Timestamp.now(),
  };

  it("tenant member reads quote", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), quotePath), quoteData);
    });
    await assertSucceeds(
      getDoc(doc(authed("alice", { tenantId: "t1" }), quotePath)),
    );
  });

  it("customer cannot write quote", async () => {
    await assertFails(
      setDoc(
        doc(
          authed("cust1", { email: "customer@example.com", email_verified: true }),
          quotePath,
        ),
        quoteData,
      ),
    );
  });
});

describe("platformAdmins/{uid}", () => {
  it("platform admin reads platformAdmins collection", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "platformAdmins/root"), {
        uid: "root",
        email: "r@x.com",
      });
    });
    await assertSucceeds(
      getDoc(
        doc(authed("root", { platformAdmin: true }), "platformAdmins/root"),
      ),
    );
  });

  it("non-admin cannot read", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "platformAdmins/root"), {
        uid: "root",
      });
    });
    await assertFails(
      getDoc(doc(authed("alice", { tenantId: "t1" }), "platformAdmins/root")),
    );
  });
});

describe("tenants/{tenantId}/entitlements (write-lock)", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "tenants/t1/entitlements/current"), {
        plan: "free",
        features: { invoices: true },
      });
    });
  });

  it("tenant member reads own entitlements", async () => {
    await assertSucceeds(
      getDoc(
        doc(authed("alice", { tenantId: "t1" }), "tenants/t1/entitlements/current"),
      ),
    );
  });

  it("non-member tenant cannot read entitlements", async () => {
    await assertFails(
      getDoc(
        doc(authed("eve", { tenantId: "t2" }), "tenants/t1/entitlements/current"),
      ),
    );
  });

  it("tenant member cannot write own entitlements (admin-SDK / platform-admin only)", async () => {
    await assertFails(
      setDoc(
        doc(authed("alice", { tenantId: "t1" }), "tenants/t1/entitlements/current"),
        { plan: "pro", features: { recurringInvoices: true } },
      ),
    );
  });

  it("tenant owner cannot write entitlements either", async () => {
    await assertFails(
      setDoc(
        doc(
          authed("alice", { tenantId: "t1", role: "owner" }),
          "tenants/t1/entitlements/current",
        ),
        { plan: "pro" },
      ),
    );
  });
});

describe("tenants/{tenantId} cross-tenant isolation (every subcollection)", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore();
      await setDoc(doc(fs, "tenants/t1/counters/invoiceCounter"), { last: 5 });
      await setDoc(doc(fs, "tenants/t1/customers/c1"), {
        name: "Bob",
        email: "bob@example.com",
      });
      await setDoc(doc(fs, "tenants/t1/recurringInvoices/r1"), {
        name: "Monthly",
      });
      await setDoc(doc(fs, "tenants/t1/invitations/i1"), {
        email: "staff@example.com",
        role: "staff",
      });
      await setDoc(
        doc(fs, "tenants/t1/invoices/inv1/paymentIncidents/inc1"),
        { kind: "auto-refund-version-mismatch", at: Timestamp.now() },
      );
    });
  });

  const t2Member = () => authed("eve", { tenantId: "t2" });
  const noTenant = () => authed("ghost", {});

  it("t2 member cannot read t1 counters", async () => {
    await assertFails(
      getDoc(doc(t2Member(), "tenants/t1/counters/invoiceCounter")),
    );
  });

  it("t2 member cannot read t1 customers", async () => {
    await assertFails(getDoc(doc(t2Member(), "tenants/t1/customers/c1")));
  });

  it("t2 member cannot read t1 recurringInvoices", async () => {
    await assertFails(
      getDoc(doc(t2Member(), "tenants/t1/recurringInvoices/r1")),
    );
  });

  it("t2 member cannot read t1 invitations", async () => {
    await assertFails(getDoc(doc(t2Member(), "tenants/t1/invitations/i1")));
  });

  it("t2 member cannot read t1 paymentIncidents", async () => {
    await assertFails(
      getDoc(
        doc(t2Member(), "tenants/t1/invoices/inv1/paymentIncidents/inc1"),
      ),
    );
  });

  it("user with NO tenantId claim cannot read t1 meta", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "tenants/t1/meta/settings"), {
        name: "Acme",
      });
    });
    await assertFails(getDoc(doc(noTenant(), "tenants/t1/meta/settings")));
  });

  it("user with NO tenantId claim cannot read t1 invoices (tenant path)", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "tenants/t1/invoices/inv-x"), {
        customer: { email: "someone@example.com" },
      });
    });
    await assertFails(getDoc(doc(noTenant(), "tenants/t1/invoices/inv-x")));
  });

  it("t2 member cannot write any t1 subcollection (counters)", async () => {
    await assertFails(
      setDoc(doc(t2Member(), "tenants/t1/counters/invoiceCounter"), {
        last: 999,
      }),
    );
  });

  it("t2 member cannot write any t1 subcollection (customers)", async () => {
    await assertFails(
      setDoc(doc(t2Member(), "tenants/t1/customers/c1"), { name: "hacked" }),
    );
  });
});

describe("customer cannot write invoices or quotes (read-only via email-match)", () => {
  const customer = () =>
    authed("cust1", { email: "customer@example.com", email_verified: true });

  it("customer cannot create an invoice", async () => {
    await assertFails(
      setDoc(doc(customer(), "tenants/t1/invoices/new-inv"), {
        customer: { email: "customer@example.com" },
        total: 100,
      }),
    );
  });

  it("customer cannot update an existing invoice (e.g. flip status to paid)", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "tenants/t1/invoices/inv1"), {
        customer: { email: "customer@example.com" },
        status: "sent",
        total: 100,
      });
    });
    await assertFails(
      setDoc(
        doc(customer(), "tenants/t1/invoices/inv1"),
        { status: "paid" },
        { merge: true },
      ),
    );
  });

  it("customer cannot read paymentIncidents (tenant-staff-only)", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "tenants/t1/invoices/inv1"), {
        customer: { email: "customer@example.com" },
      });
      await setDoc(
        doc(ctx.firestore(), "tenants/t1/invoices/inv1/paymentIncidents/i1"),
        { kind: "dispute" },
      );
    });
    await assertFails(
      getDoc(
        doc(customer(), "tenants/t1/invoices/inv1/paymentIncidents/i1"),
      ),
    );
  });
});

describe("admin-SDK-only collections (clients fully blocked)", () => {
  const member = () => authed("alice", { tenantId: "t1" });
  const platformAdmin = () => authed("root", { platformAdmin: true });

  it("customDomains denies read for member, platform admin, unauth", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "customDomains/foo.example.com"), {
        tenantId: "t1",
      });
    });
    await assertFails(getDoc(doc(member(), "customDomains/foo.example.com")));
    await assertFails(
      getDoc(doc(platformAdmin(), "customDomains/foo.example.com")),
    );
    await assertFails(
      getDoc(doc(unauthed(), "customDomains/foo.example.com")),
    );
  });

  it("stripeAccounts denies read for everyone", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "stripeAccounts/acct_x"), {
        tenantId: "t1",
      });
    });
    await assertFails(getDoc(doc(member(), "stripeAccounts/acct_x")));
    await assertFails(getDoc(doc(platformAdmin(), "stripeAccounts/acct_x")));
  });

  it("stripeEvents denies read/write for everyone (idempotency sentinel)", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "stripeEvents/evt_1"), {
        type: "checkout.session.completed",
      });
    });
    await assertFails(getDoc(doc(member(), "stripeEvents/evt_1")));
    await assertFails(
      setDoc(doc(member(), "stripeEvents/evt_2"), { type: "x" }),
    );
  });

  it("payAttempts (subcollection) denies read for tenant member", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), "tenants/t1/invoices/inv1/payAttempts/a1"),
        { ip: "1.2.3.4", at: Timestamp.now() },
      );
    });
    await assertFails(
      getDoc(doc(member(), "tenants/t1/invoices/inv1/payAttempts/a1")),
    );
  });
});

describe("default deny", () => {
  it("random path is denied for reads", async () => {
    await assertFails(
      getDoc(doc(authed("alice", { tenantId: "t1" }), "randomCollection/doc1")),
    );
  });

  it("random path is denied for writes", async () => {
    await assertFails(
      setDoc(
        doc(authed("alice", { tenantId: "t1" }), "randomCollection/doc1"),
        { x: 1 },
      ),
    );
  });
});
