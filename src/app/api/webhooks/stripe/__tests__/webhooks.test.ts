import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

// ---------------------------------------------------------------------------
// Module mocks — MUST be declared before route imports
// ---------------------------------------------------------------------------

// In-memory Firestore stand-in. Each doc path maps to its data; ops mutate this
// map so assertions can read the resulting state. Enough fidelity for webhook
// routing, status mirroring, and reverse-lookup deletion.
const store = new Map<string, Record<string, unknown> | null>();

function makeDocRef(path: string) {
  return {
    path,
    get: vi.fn(async () => {
      const data = store.get(path);
      return {
        exists: data != null,
        data: () => data ?? undefined,
      };
    }),
    set: vi.fn(
      async (
        value: Record<string, unknown>,
        opts?: { merge?: boolean },
      ) => {
        if (opts?.merge) {
          const prev = store.get(path) ?? {};
          store.set(path, { ...prev, ...value });
        } else {
          store.set(path, { ...value });
        }
      },
    ),
    delete: vi.fn(async () => {
      store.delete(path);
    }),
  };
}

const fakeDb = {
  doc: vi.fn((path: string) => makeDocRef(path)),
  runTransaction: vi.fn(async (fn: (tx: FakeTx) => Promise<unknown>) => {
    const tx: FakeTx = {
      get: async (ref: { path: string }) => {
        const data = store.get(ref.path);
        return { exists: data != null, data: () => data ?? undefined };
      },
      set: (ref: { path: string }, value: Record<string, unknown>) => {
        store.set(ref.path, { ...value });
      },
    };
    return await fn(tx);
  }),
  batch: () => {
    const ops: Array<() => void> = [];
    return {
      set: (
        ref: { path: string },
        value: Record<string, unknown>,
        opts?: { merge?: boolean },
      ) => {
        ops.push(() => {
          if (opts?.merge) {
            const prev = store.get(ref.path) ?? {};
            store.set(ref.path, { ...prev, ...value });
          } else {
            store.set(ref.path, { ...value });
          }
        });
      },
      delete: (ref: { path: string }) => {
        ops.push(() => {
          store.delete(ref.path);
        });
      },
      commit: async () => {
        for (const op of ops) op();
      },
    };
  },
};

interface FakeTx {
  get: (ref: { path: string }) => Promise<{
    exists: boolean;
    data: () => Record<string, unknown> | undefined;
  }>;
  set: (ref: { path: string }, value: Record<string, unknown>) => void;
}

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => fakeDb,
}));

// FieldValue / Timestamp — the webhook code stamps these into docs, but the
// tests only need them to round-trip as recognisable sentinels.
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    serverTimestamp: () => ({ __fieldvalue: "serverTimestamp" }),
  },
  Timestamp: {
    fromMillis: (ms: number) => ({ __timestamp: ms }),
  },
}));

// Stripe client — constructEvent returns whatever we prime.
const constructEvent = vi.fn<(body: string, sig: string, secret: string) => Stripe.Event>();
vi.mock("@/lib/stripe/admin", () => ({
  getStripeClient: () => ({ webhooks: { constructEvent } }),
}));

// ---------------------------------------------------------------------------
// Route imports — AFTER mocks are wired
// ---------------------------------------------------------------------------

import { POST as platformPOST } from "../platform/route";
import { POST as connectPOST } from "../connect/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  store.clear();
  constructEvent.mockReset();
}

function makeRequest(body: string, sig: string | null = "t=1,v1=fake"): Request {
  return new Request("http://localhost/api/webhooks/stripe/platform", {
    method: "POST",
    headers: sig ? { "stripe-signature": sig } : {},
    body,
  });
}

beforeEach(() => {
  resetStore();
  process.env.STRIPE_PLATFORM_WEBHOOK_SECRET = "whsec_platform_test";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Platform webhook
// ---------------------------------------------------------------------------

describe("platform webhook — POST /api/webhooks/stripe/platform", () => {
  it("rejects missing stripe-signature header", async () => {
    const res = await platformPOST(makeRequest("{}", null));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing signature." });
  });

  it("rejects failed signature verification", async () => {
    constructEvent.mockImplementation(() => {
      throw new Error("bad sig");
    });
    const res = await platformPOST(makeRequest("{}"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Signature verification failed/);
  });

  it("rejects Connect events delivered to the platform endpoint", async () => {
    constructEvent.mockReturnValue({
      id: "evt_1",
      type: "checkout.session.completed",
      account: "acct_123",
      livemode: false,
      data: { object: {} },
    } as unknown as Stripe.Event);
    const res = await platformPOST(makeRequest("{}"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Connect event delivered to platform endpoint.",
    });
  });

  it("account.updated mirrors capability state into tenant meta", async () => {
    store.set("stripeAccounts/acct_abc", { tenantId: "tnt_acme" });
    constructEvent.mockReturnValue({
      id: "evt_a",
      type: "account.updated",
      account: null,
      livemode: false,
      data: {
        object: {
          id: "acct_abc",
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          requirements: { currently_due: [], disabled_reason: null },
        },
      },
    } as unknown as Stripe.Event);

    const res = await platformPOST(makeRequest("{}"));
    expect(res.status).toBe(200);

    const meta = store.get("tenants/tnt_acme/meta/settings") as
      | { stripeStatus?: Record<string, unknown> }
      | undefined;
    expect(meta?.stripeStatus).toMatchObject({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      currentlyDue: [],
      disabledReason: null,
    });

    // Idempotency sentinel written
    expect(store.get("stripeEvents/evt_a")).toMatchObject({
      type: "account.updated",
    });
  });

  it("account.updated is idempotent — a redelivered event is a no-op", async () => {
    store.set("stripeAccounts/acct_abc", { tenantId: "tnt_acme" });
    const primeEvent = () => {
      constructEvent.mockReturnValue({
        id: "evt_dup",
        type: "account.updated",
        account: null,
        livemode: false,
        data: {
          object: {
            id: "acct_abc",
            charges_enabled: true,
            payouts_enabled: true,
            details_submitted: true,
            requirements: { currently_due: [], disabled_reason: null },
          },
        },
      } as unknown as Stripe.Event);
    };

    primeEvent();
    await platformPOST(makeRequest("{}"));

    // Corrupt the meta doc so we can prove the second delivery did NOT re-run
    // the handler (if it did, stripeStatus would be rewritten).
    store.set("tenants/tnt_acme/meta/settings", { stripeStatus: { poisoned: true } });

    primeEvent();
    const res = await platformPOST(makeRequest("{}"));
    const body = await res.json();
    expect(body).toEqual({ received: true, duplicate: true });

    const meta = store.get("tenants/tnt_acme/meta/settings") as
      | { stripeStatus?: { poisoned?: boolean } }
      | undefined;
    expect(meta?.stripeStatus?.poisoned).toBe(true);
  });

  it("account.updated for unknown account logs and returns 200 without writing meta", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    constructEvent.mockReturnValue({
      id: "evt_b",
      type: "account.updated",
      account: null,
      livemode: false,
      data: {
        object: {
          id: "acct_ghost",
          charges_enabled: true,
          payouts_enabled: false,
          details_submitted: true,
          requirements: { currently_due: [], disabled_reason: null },
        },
      },
    } as unknown as Stripe.Event);
    const res = await platformPOST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("account.application.deauthorized clears tenant linkage and drops reverse lookup", async () => {
    store.set("stripeAccounts/acct_xyz", { tenantId: "tnt_bye" });
    store.set("tenants/tnt_bye/meta/settings", {
      stripeAccountId: "acct_xyz",
      stripeStatus: { chargesEnabled: true },
    });

    constructEvent.mockReturnValue({
      id: "evt_c",
      type: "account.application.deauthorized",
      account: null,
      livemode: false,
      data: { object: { id: "acct_xyz" } },
    } as unknown as Stripe.Event);

    const res = await platformPOST(makeRequest("{}"));
    expect(res.status).toBe(200);

    expect(store.has("stripeAccounts/acct_xyz")).toBe(false);
    const meta = store.get("tenants/tnt_bye/meta/settings") as
      | { stripeAccountId?: string | null; stripeStatus?: { chargesEnabled?: boolean } }
      | undefined;
    expect(meta?.stripeAccountId).toBeNull();
    expect(meta?.stripeStatus?.chargesEnabled).toBe(false);
  });

  it("unknown event type is acknowledged (Stripe stops retrying)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    constructEvent.mockReturnValue({
      id: "evt_x",
      type: "account.external_account.created",
      account: null,
      livemode: false,
      data: { object: {} },
    } as unknown as Stripe.Event);
    const res = await platformPOST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Connect webhook
// ---------------------------------------------------------------------------

describe("connect webhook — POST /api/webhooks/stripe/connect", () => {
  it("rejects missing stripe-signature header", async () => {
    const res = await connectPOST(makeRequest("{}", null));
    expect(res.status).toBe(400);
  });

  it("rejects failed signature verification", async () => {
    constructEvent.mockImplementation(() => {
      throw new Error("bad sig");
    });
    const res = await connectPOST(makeRequest("{}"));
    expect(res.status).toBe(400);
  });

  it("rejects platform events delivered to the Connect endpoint", async () => {
    constructEvent.mockReturnValue({
      id: "evt_p",
      type: "account.updated",
      account: null,
      livemode: false,
      data: { object: {} },
    } as unknown as Stripe.Event);
    const res = await connectPOST(makeRequest("{}"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Platform event delivered to Connect endpoint.",
    });
  });

  it("unlinkable account yields 200 + ignored marker (Stripe stops retrying)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    constructEvent.mockReturnValue({
      id: "evt_u",
      type: "checkout.session.completed",
      account: "acct_unknown",
      livemode: false,
      data: { object: {} },
    } as unknown as Stripe.Event);
    const res = await connectPOST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      received: true,
      ignored: "unlinkable-account",
    });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("claims known event types and writes the idempotency sentinel", async () => {
    store.set("stripeAccounts/acct_live", { tenantId: "tnt_live" });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    constructEvent.mockReturnValue({
      id: "evt_live",
      type: "checkout.session.completed",
      account: "acct_live",
      livemode: true,
      data: { object: {} },
    } as unknown as Stripe.Event);

    const res = await connectPOST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });

    expect(store.get("stripeEvents/evt_live")).toMatchObject({
      type: "checkout.session.completed",
      account: "acct_live",
      livemode: true,
    });
    info.mockRestore();
  });

  it("redelivered event returns duplicate:true and does not re-dispatch", async () => {
    store.set("stripeAccounts/acct_live", { tenantId: "tnt_live" });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const prime = () => {
      constructEvent.mockReturnValue({
        id: "evt_dup_c",
        type: "charge.refunded",
        account: "acct_live",
        livemode: false,
        data: { object: {} },
      } as unknown as Stripe.Event);
    };

    prime();
    await connectPOST(makeRequest("{}"));
    info.mockClear();

    prime();
    const res = await connectPOST(makeRequest("{}"));
    const body = await res.json();
    expect(body).toEqual({ received: true, duplicate: true });
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("dispute events are acknowledged in Bundle C (handlers land in Bundle D)", async () => {
    store.set("stripeAccounts/acct_live", { tenantId: "tnt_live" });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    constructEvent.mockReturnValue({
      id: "evt_disp",
      type: "charge.dispute.created",
      account: "acct_live",
      livemode: false,
      data: { object: {} },
    } as unknown as Stripe.Event);
    const res = await connectPOST(makeRequest("{}"));
    expect(res.status).toBe(200);
    info.mockRestore();
  });
});
