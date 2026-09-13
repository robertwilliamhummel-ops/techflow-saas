import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

// ---------------------------------------------------------------------------
// In-memory Firestore stand-in. Docs, collections, and queries are supported
// enough to exercise the handler code paths.
// ---------------------------------------------------------------------------

const docs = new Map<string, Record<string, unknown>>();
const collections = new Map<string, Map<string, Record<string, unknown>>>();

interface FakeDocRef {
  path: string;
  id: string;
  get: () => Promise<{
    exists: boolean;
    data: () => Record<string, unknown> | undefined;
    ref: FakeDocRef;
  }>;
  set: (
    value: Record<string, unknown>,
    opts?: { merge?: boolean },
  ) => Promise<void>;
  delete: () => Promise<void>;
}

function applySet(
  path: string,
  value: Record<string, unknown>,
  opts?: { merge?: boolean },
): void {
  if (opts?.merge) {
    docs.set(path, { ...(docs.get(path) ?? {}), ...value });
  } else {
    docs.set(path, { ...value });
  }
}

function docRef(path: string): FakeDocRef {
  return {
    path,
    id: path.split("/").pop() ?? path,
    get: async () => ({
      exists: docs.has(path),
      data: () => docs.get(path),
      ref: docRef(path),
    }),
    set: async (
      value: Record<string, unknown>,
      opts?: { merge?: boolean },
    ) => {
      applySet(path, value, opts);
    },
    delete: async () => {
      docs.delete(path);
    },
  };
}

interface FakeCollRef {
  path: string;
  where: (field: string, op: "==", value: unknown) => FakeQuery;
  add: (value: Record<string, unknown>) => Promise<{ id: string }>;
}

interface FakeQuery {
  limit: (n: number) => FakeQuery;
  get: () => Promise<{
    empty: boolean;
    docs: Array<{
      id: string;
      data: () => Record<string, unknown>;
      ref: FakeDocRef;
    }>;
  }>;
}

function collectionRef(path: string): FakeCollRef {
  const entries = (): Array<[string, Record<string, unknown>]> => {
    const out: Array<[string, Record<string, unknown>]> = [];
    // Prefer explicitly-seeded collection entries when present; fall back to
    // scanning docs for any path matching `${path}/{id}`.
    const c = collections.get(path);
    if (c) {
      for (const [id, data] of c.entries()) out.push([id, data]);
    }
    const prefix = `${path}/`;
    for (const [docPath, data] of docs.entries()) {
      if (docPath.startsWith(prefix)) {
        const rest = docPath.slice(prefix.length);
        if (!rest.includes("/")) out.push([rest, data]);
      }
    }
    return out;
  };

  return {
    path,
    where(field: string, op: "==", value: unknown): FakeQuery {
      let limitN = Infinity;
      const q: FakeQuery = {
        limit(n: number) {
          limitN = n;
          return q;
        },
        get: async () => {
          const matched = entries()
            .filter(([, data]) => data[field] === value)
            .slice(0, limitN);
          return {
            empty: matched.length === 0,
            docs: matched.map(([id, data]) => ({
              id,
              data: () => data,
              ref: docRef(`${path}/${id}`),
            })),
          };
        },
      };
      return q;
    },
    add: async (value: Record<string, unknown>) => {
      const id = `auto_${Math.random().toString(36).slice(2, 10)}`;
      let c = collections.get(path);
      if (!c) {
        c = new Map();
        collections.set(path, c);
      }
      c.set(id, { ...value });
      docs.set(`${path}/${id}`, { ...value });
      return { id };
    },
  };
}

const fakeDb = {
  doc: (path: string) => docRef(path),
  collection: (path: string) => collectionRef(path),
  batch: () => {
    const ops: Array<() => void> = [];
    return {
      set: (
        ref: { path: string },
        value: Record<string, unknown>,
        opts?: { merge?: boolean },
      ) => {
        ops.push(() => applySet(ref.path, value, opts));
      },
      delete: (ref: { path: string }) => {
        ops.push(() => {
          docs.delete(ref.path);
        });
      },
      commit: async () => {
        for (const op of ops) op();
      },
    };
  },
};

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => fakeDb,
}));

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    serverTimestamp: () => ({ __fieldvalue: "serverTimestamp" }),
  },
  Timestamp: {
    fromMillis: (ms: number) => ({ __timestamp: ms }),
  },
}));

// Stripe client — the only method handlers invoke is refunds.create.
const refundsCreate = vi.fn();
vi.mock("@/lib/stripe/admin", () => ({
  getStripeClient: () => ({
    refunds: { create: (...args: unknown[]) => refundsCreate(...args) },
  }),
}));

// Owner emails are sent by the Cloud Functions trigger onPaymentIncidentCreated
// (D5); these handlers only write the incident docs that trigger it.
function incidentDocs(tenantId: string, invoiceId: string) {
  return [...docs.entries()].filter(([k]) =>
    k.startsWith(`tenants/${tenantId}/invoices/${invoiceId}/paymentIncidents/`),
  );
}

import {
  handleAccountDeauthorized,
  handleAccountUpdated,
  handleChargeRefunded,
  handleCheckoutCompleted,
  handleDisputeClosed,
  handleDisputeCreated,
  handlePaymentFailed,
} from "../handlers";

function resetState(): void {
  docs.clear();
  collections.clear();
  refundsCreate.mockReset();
}

beforeEach(() => {
  resetState();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// handleCheckoutCompleted — paid path + C2 version guard
// ---------------------------------------------------------------------------

describe("handleCheckoutCompleted", () => {
  const TENANT = "tnt_acme";
  const INVOICE = "INV-0001";
  const ACCT = "acct_connected";

  function seedInvoice(overrides: Record<string, unknown> = {}): void {
    docs.set(`tenants/${TENANT}/invoices/${INVOICE}`, {
      status: "sent",
      payTokenVersion: 3,
      totals: { total: 113 },
      ...overrides,
    });
  }

  function session(metadata: Record<string, string>, paymentIntent = "pi_123") {
    return {
      id: "cs_test_abc",
      payment_intent: paymentIntent,
      metadata,
      livemode: false,
    } as unknown as Stripe.Checkout.Session;
  }

  function event(
    sess: Stripe.Checkout.Session,
    account: string | null = ACCT,
  ): Stripe.Event {
    return {
      id: "evt_1",
      type: "checkout.session.completed",
      account,
      data: { object: sess },
    } as unknown as Stripe.Event;
  }

  it("marks invoice paid when metadata version matches current version", async () => {
    seedInvoice();
    await handleCheckoutCompleted(
      TENANT,
      event(
        session({
          invoiceId: INVOICE,
          tenantId: TENANT,
          payTokenVersion: "3",
          basePaidCents: "11300",
          surchargeCents: "271",
        }),
      ),
    );

    const inv = docs.get(`tenants/${TENANT}/invoices/${INVOICE}`);
    expect(inv?.status).toBe("paid");
    // "card" — the value the PDF template branches on for the surcharge receipt row.
    expect(inv?.paymentMethod).toBe("card");
    expect(inv?.paidAmountCents).toBe(11300);
    expect(inv?.surchargeAmountCents).toBe(271);
    expect(inv?.stripeChargeId).toBe("pi_123");
    expect(inv?.paidAt).toBeDefined();

    expect(refundsCreate).not.toHaveBeenCalled();
    expect(
      [...docs.keys()].some((k) =>
        k.startsWith(`tenants/${TENANT}/invoices/${INVOICE}/paymentIncidents/`),
      ),
    ).toBe(false);
  });

  it("C2 version mismatch — auto-refunds, does NOT mark paid, writes incident", async () => {
    seedInvoice({ payTokenVersion: 5 });
    refundsCreate.mockResolvedValue({ id: "re_refund_777" });

    await handleCheckoutCompleted(
      TENANT,
      event(
        session({
          invoiceId: INVOICE,
          tenantId: TENANT,
          payTokenVersion: "3", // older than invoice's 5 → mismatch
          basePaidCents: "11300",
          surchargeCents: "0",
        }),
      ),
    );

    const inv = docs.get(`tenants/${TENANT}/invoices/${INVOICE}`);
    expect(inv?.status).toBe("sent"); // NOT paid
    expect(inv?.paidAt).toBeUndefined();

    expect(refundsCreate).toHaveBeenCalledTimes(1);
    expect(refundsCreate).toHaveBeenCalledWith(
      { payment_intent: "pi_123", reason: "requested_by_customer" },
      { stripeAccount: ACCT },
    );

    const incidents = [...docs.entries()].filter(([k]) =>
      k.startsWith(`tenants/${TENANT}/invoices/${INVOICE}/paymentIncidents/`),
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0][1]).toMatchObject({
      reason: "version-mismatch",
      sessionId: "cs_test_abc",
      metadataVersion: 3,
      currentVersion: 5,
      refundId: "re_refund_777",
    });
    // Deterministic id + kind — the email trigger keys off both (D5).
    expect(incidents[0][0]).toBe(
      `tenants/${TENANT}/invoices/${INVOICE}/paymentIncidents/auto-refund_cs_test_abc`,
    );
    expect(incidents[0][1]).toMatchObject({
      kind: "auto-refund-version-mismatch",
    });
  });

  it("C2 version mismatch redelivered — same incident doc, no duplicate", async () => {
    seedInvoice({ payTokenVersion: 5 });
    refundsCreate.mockResolvedValue({ id: "re_refund_777" });
    const evt = event(
      session({
        invoiceId: INVOICE,
        tenantId: TENANT,
        payTokenVersion: "3",
        basePaidCents: "11300",
        surchargeCents: "0",
      }),
    );

    await handleCheckoutCompleted(TENANT, evt);
    await handleCheckoutCompleted(TENANT, evt);

    expect(incidentDocs(TENANT, INVOICE)).toHaveLength(1);
  });

  it("C2 version mismatch — refund failure still writes incident with error", async () => {
    seedInvoice({ payTokenVersion: 5 });
    refundsCreate.mockRejectedValue(new Error("card_declined"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleCheckoutCompleted(
      TENANT,
      event(
        session({
          invoiceId: INVOICE,
          tenantId: TENANT,
          payTokenVersion: "3",
          basePaidCents: "11300",
          surchargeCents: "0",
        }),
      ),
    );

    const incidents = [...docs.entries()].filter(([k]) =>
      k.startsWith(`tenants/${TENANT}/invoices/${INVOICE}/paymentIncidents/`),
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0][1]).toMatchObject({
      reason: "version-mismatch",
      refundId: null,
      refundError: "card_declined",
    });
    expect(incidents[0][1]).toMatchObject({
      kind: "auto-refund-version-mismatch",
    });
    err.mockRestore();
  });

  it("matches version → writes no incident (nothing to email)", async () => {
    seedInvoice();
    await handleCheckoutCompleted(
      TENANT,
      event(
        session({
          invoiceId: INVOICE,
          tenantId: TENANT,
          payTokenVersion: "3",
          basePaidCents: "11300",
          surchargeCents: "0",
        }),
      ),
    );
    expect(incidentDocs(TENANT, INVOICE)).toHaveLength(0);
  });

  it("is a no-op when the invoice is already paid (duplicate-safety net)", async () => {
    seedInvoice({ status: "paid", payTokenVersion: 3 });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await handleCheckoutCompleted(
      TENANT,
      event(
        session({
          invoiceId: INVOICE,
          tenantId: TENANT,
          payTokenVersion: "3",
          basePaidCents: "11300",
          surchargeCents: "0",
        }),
      ),
    );

    expect(refundsCreate).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });

  it("writes a tenant-mismatch incident when metadata.tenantId disagrees with routed tenantId", async () => {
    seedInvoice();
    await handleCheckoutCompleted(
      TENANT,
      event(
        session({
          invoiceId: INVOICE,
          tenantId: "tnt_spoofed",
          payTokenVersion: "3",
          basePaidCents: "11300",
          surchargeCents: "0",
        }),
      ),
    );

    const inv = docs.get(`tenants/${TENANT}/invoices/${INVOICE}`);
    expect(inv?.status).toBe("sent"); // NOT paid

    const incidents = [...docs.entries()].filter(([k]) =>
      k.startsWith(`tenants/${TENANT}/invoices/${INVOICE}/paymentIncidents/`),
    );
    expect(incidents[0][1]).toMatchObject({
      reason: "tenant-mismatch",
      metadataTenantId: "tnt_spoofed",
      routedTenantId: TENANT,
    });
  });

  it("bails silently when required metadata is missing", async () => {
    seedInvoice();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleCheckoutCompleted(
      TENANT,
      event(session({})), // no metadata
    );
    expect(err).toHaveBeenCalled();
    expect(refundsCreate).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// handleChargeRefunded
// ---------------------------------------------------------------------------

describe("handleChargeRefunded", () => {
  const TENANT = "tnt_acme";

  function chargeEvent(charge: Partial<Stripe.Charge>): Stripe.Event {
    return {
      id: "evt_cr",
      type: "charge.refunded",
      account: "acct_x",
      data: { object: charge },
    } as unknown as Stripe.Event;
  }

  it("full refund → status 'refunded' + refund fields", async () => {
    docs.set(`tenants/${TENANT}/invoices/INV-1`, {
      status: "paid",
      stripeChargeId: "ch_abc",
      paidAmountCents: 11300,
    });

    await handleChargeRefunded(
      TENANT,
      chargeEvent({
        id: "ch_abc",
        amount: 11300,
        amount_refunded: 11300,
      }),
    );

    const inv = docs.get(`tenants/${TENANT}/invoices/INV-1`);
    expect(inv?.status).toBe("refunded");
    expect(inv?.refundedAmountCents).toBe(11300);
    expect(inv?.refundedAt).toBeDefined();
    // paidAmountCents preserved — accounting needs to know the original charge
    expect(inv?.paidAmountCents).toBe(11300);
  });

  it("partial refund → status 'partially-refunded'", async () => {
    docs.set(`tenants/${TENANT}/invoices/INV-2`, {
      status: "paid",
      stripeChargeId: "ch_def",
      paidAmountCents: 11300,
    });

    await handleChargeRefunded(
      TENANT,
      chargeEvent({
        id: "ch_def",
        amount: 11300,
        amount_refunded: 5000,
      }),
    );

    const inv = docs.get(`tenants/${TENANT}/invoices/INV-2`);
    expect(inv?.status).toBe("partially-refunded");
    expect(inv?.refundedAmountCents).toBe(5000);
  });

  it("is a no-op when no invoice has this stripeChargeId", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await handleChargeRefunded(
      TENANT,
      chargeEvent({ id: "ch_orphan", amount: 100, amount_refunded: 100 }),
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// handleDisputeCreated / handleDisputeClosed
// ---------------------------------------------------------------------------

describe("handleDisputeCreated", () => {
  const TENANT = "tnt_acme";

  it("sets disputed=true + reason + disputedAt", async () => {
    docs.set(`tenants/${TENANT}/invoices/INV-3`, {
      status: "paid",
      stripeChargeId: "ch_disputed",
    });

    // due_by epoch seconds → 2026-05-15
    const dueBySec = Math.floor(new Date("2026-05-15T00:00:00Z").getTime() / 1000);

    const event = {
      id: "evt_d",
      type: "charge.dispute.created",
      account: "acct_x",
      data: {
        object: {
          id: "dp_1",
          charge: "ch_disputed",
          reason: "fraudulent",
          amount: 11300,
          evidence_details: { due_by: dueBySec },
        },
      },
    } as unknown as Stripe.Event;

    await handleDisputeCreated(TENANT, event);

    const inv = docs.get(`tenants/${TENANT}/invoices/INV-3`);
    expect(inv?.disputed).toBe(true);
    expect(inv?.disputeReason).toBe("fraudulent");
    expect(inv?.disputedAt).toBeDefined();
    expect(inv?.disputeOutcome).toBeNull();
    // status stays 'paid' — dispute isn't resolved yet
    expect(inv?.status).toBe("paid");

    const incident = docs.get(
      `tenants/${TENANT}/invoices/INV-3/paymentIncidents/dispute-created_dp_1`,
    );
    expect(incident).toMatchObject({
      kind: "dispute-created",
      disputeId: "dp_1",
      disputeReason: "fraudulent",
      evidenceDueBy: "2026-05-15",
      amountCents: 11300,
    });
  });

  it("records an incident even when reason is missing (defaults to 'unspecified')", async () => {
    docs.set(`tenants/${TENANT}/invoices/INV-3b`, {
      status: "paid",
      stripeChargeId: "ch_disputed_b",
    });

    await handleDisputeCreated(TENANT, {
      id: "evt_db",
      type: "charge.dispute.created",
      account: "acct_x",
      data: {
        object: { id: "dp_2", charge: "ch_disputed_b", amount: 5000 },
      },
    } as unknown as Stripe.Event);

    expect(
      docs.get(
        `tenants/${TENANT}/invoices/INV-3b/paymentIncidents/dispute-created_dp_2`,
      ),
    ).toMatchObject({ kind: "dispute-created", disputeReason: "unspecified" });
  });
});

describe("handleDisputeClosed", () => {
  const TENANT = "tnt_acme";

  function event(status: string, amount = 11300): Stripe.Event {
    return {
      id: `evt_close_${status}`,
      type: "charge.dispute.closed",
      account: "acct_x",
      data: {
        object: {
          id: "dp_1",
          charge: "ch_disputed",
          status,
          reason: "fraudulent",
          amount,
        },
      },
    } as unknown as Stripe.Event;
  }

  it("status='won' → clears disputed, sets outcome=won, invoice stays paid", async () => {
    docs.set(`tenants/${TENANT}/invoices/INV-4`, {
      status: "paid",
      stripeChargeId: "ch_disputed",
      disputed: true,
    });

    await handleDisputeClosed(TENANT, event("won"));

    const inv = docs.get(`tenants/${TENANT}/invoices/INV-4`);
    expect(inv?.disputed).toBe(false);
    expect(inv?.disputeOutcome).toBe("won");
    expect(inv?.status).toBe("paid");
    expect(incidentDocs(TENANT, "INV-4")).toHaveLength(0);
  });

  it("status='lost' → clears disputed, sets outcome=lost, flips status to refunded", async () => {
    docs.set(`tenants/${TENANT}/invoices/INV-5`, {
      status: "paid",
      stripeChargeId: "ch_disputed",
      disputed: true,
    });

    await handleDisputeClosed(TENANT, event("lost", 11300));

    const inv = docs.get(`tenants/${TENANT}/invoices/INV-5`);
    expect(inv?.disputed).toBe(false);
    expect(inv?.disputeOutcome).toBe("lost");
    expect(inv?.status).toBe("refunded");
    expect(inv?.refundedAmountCents).toBe(11300);
    expect(inv?.refundedAt).toBeDefined();
    expect(
      docs.get(
        `tenants/${TENANT}/invoices/INV-5/paymentIncidents/dispute-lost_dp_1`,
      ),
    ).toMatchObject({
      kind: "dispute-lost",
      amountCents: 11300,
      disputeId: "dp_1",
      outcomeStatus: "lost",
    });
  });

  it("status='charge_refunded' is also treated as lost (chargeback went through)", async () => {
    docs.set(`tenants/${TENANT}/invoices/INV-6`, {
      status: "paid",
      stripeChargeId: "ch_disputed",
      disputed: true,
    });

    await handleDisputeClosed(TENANT, event("charge_refunded"));

    const inv = docs.get(`tenants/${TENANT}/invoices/INV-6`);
    expect(inv?.status).toBe("refunded");
    expect(inv?.disputeOutcome).toBe("lost");
    expect(
      docs.get(
        `tenants/${TENANT}/invoices/INV-6/paymentIncidents/dispute-lost_dp_1`,
      ),
    ).toMatchObject({
      kind: "dispute-lost",
      outcomeStatus: "charge_refunded",
      amountCents: 11300,
    });
  });
});

// ---------------------------------------------------------------------------
// handleAccountUpdated / handleAccountDeauthorized (D1 — Connect scope)
// ---------------------------------------------------------------------------

describe("handleAccountUpdated", () => {
  const TENANT = "tnt_acme";

  function accountEvent(accountId: string): Stripe.Event {
    return {
      id: "evt_acct",
      type: "account.updated",
      account: accountId,
      data: {
        object: {
          id: accountId,
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          requirements: { currently_due: [], disabled_reason: null },
        },
      },
    } as unknown as Stripe.Event;
  }

  it("mirrors capability state into meta.stripeStatus for the tenant's current account", async () => {
    docs.set(`tenants/${TENANT}/meta/settings`, {
      stripeAccountId: "acct_live",
      stripeStatus: { chargesEnabled: false },
    });

    await handleAccountUpdated(TENANT, accountEvent("acct_live"));

    const meta = docs.get(`tenants/${TENANT}/meta/settings`) as {
      stripeStatus: Record<string, unknown>;
    };
    expect(meta.stripeStatus).toMatchObject({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      currentlyDue: [],
      disabledReason: null,
    });
  });

  it("ignores events for a non-current (recreated) account", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    docs.set(`tenants/${TENANT}/meta/settings`, {
      stripeAccountId: "acct_new",
      stripeStatus: { chargesEnabled: false },
    });

    await handleAccountUpdated(TENANT, accountEvent("acct_old"));

    const meta = docs.get(`tenants/${TENANT}/meta/settings`) as {
      stripeStatus: { chargesEnabled: boolean };
    };
    expect(meta.stripeStatus.chargesEnabled).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("handleAccountDeauthorized", () => {
  const TENANT = "tnt_bye";

  function deauthEvent(accountId: string): Stripe.Event {
    return {
      id: "evt_deauth",
      type: "account.application.deauthorized",
      account: accountId,
      // data.object is the Application, not the Account.
      data: { object: { id: "ca_platform", object: "application" } },
    } as unknown as Stripe.Event;
  }

  it("clears tenant linkage and drops the reverse lookup", async () => {
    docs.set(`stripeAccounts/acct_xyz`, { tenantId: TENANT });
    docs.set(`tenants/${TENANT}/meta/settings`, {
      stripeAccountId: "acct_xyz",
      stripeStatus: { chargesEnabled: true },
    });

    await handleAccountDeauthorized(TENANT, deauthEvent("acct_xyz"));

    expect(docs.has(`stripeAccounts/acct_xyz`)).toBe(false);
    const meta = docs.get(`tenants/${TENANT}/meta/settings`) as {
      stripeAccountId: string | null;
      stripeStatus: { chargesEnabled: boolean };
    };
    expect(meta.stripeAccountId).toBeNull();
    expect(meta.stripeStatus.chargesEnabled).toBe(false);
  });

  it("only drops the stale lookup when the tenant already moved to another account", async () => {
    docs.set(`stripeAccounts/acct_old`, { tenantId: TENANT });
    docs.set(`tenants/${TENANT}/meta/settings`, {
      stripeAccountId: "acct_new",
      stripeStatus: { chargesEnabled: true },
    });

    await handleAccountDeauthorized(TENANT, deauthEvent("acct_old"));

    expect(docs.has(`stripeAccounts/acct_old`)).toBe(false);
    const meta = docs.get(`tenants/${TENANT}/meta/settings`) as {
      stripeAccountId: string;
      stripeStatus: { chargesEnabled: boolean };
    };
    expect(meta.stripeAccountId).toBe("acct_new");
    expect(meta.stripeStatus.chargesEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handlePaymentFailed — log-only, no state mutation
// ---------------------------------------------------------------------------

describe("handlePaymentFailed", () => {
  it("logs and does not mutate invoice state", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    docs.set(`tenants/tnt_x/invoices/INV-7`, { status: "sent" });

    await handlePaymentFailed("tnt_x", {
      id: "evt_pf",
      type: "payment_intent.payment_failed",
      account: "acct_x",
      data: {
        object: {
          id: "pi_fail",
          last_payment_error: {
            code: "card_declined",
            message: "Card declined",
          },
        },
      },
    } as unknown as Stripe.Event);

    expect(info).toHaveBeenCalled();
    const inv = docs.get(`tenants/tnt_x/invoices/INV-7`);
    expect(inv?.status).toBe("sent"); // unchanged
    info.mockRestore();
  });
});
