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
