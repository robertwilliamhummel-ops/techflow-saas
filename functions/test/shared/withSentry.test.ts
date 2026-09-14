// O-01 — the Sentry wrappers report unexpected errors with tenant and user
// tags, skip a callable's expected answers, and never change behaviour.

import { beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();
const flush = vi.fn();
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  flush: (...args: unknown[]) => flush(...args),
}));

import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import {
  SENTRY_FLUSH_TIMEOUT_MS,
  reportError,
  shouldReport,
  withSentryCallable,
  withSentryEvent,
  withSentryRequest,
} from "../../src/shared/withSentry";

function callable(auth: { uid: string; tenantId?: string } | null) {
  return {
    data: {},
    auth: auth
      ? { uid: auth.uid, token: { tenantId: auth.tenantId } }
      : undefined,
  } as unknown as CallableRequest<unknown>;
}

beforeEach(() => {
  captureException.mockReset();
  flush.mockReset();
  flush.mockResolvedValue(true);
});

describe("withSentryCallable (O-01)", () => {
  it("passes results through without reporting", async () => {
    const wrapped = withSentryCallable("createQuote", async () => ({ quoteId: "QT-0001" }));
    await expect(wrapped(callable({ uid: "u1", tenantId: "acme" }))).resolves.toEqual({
      quoteId: "QT-0001",
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("reports an unexpected error with function, tenant, and user, then rethrows it", async () => {
    const boom = new Error("Tenant meta not found — corrupt tenant state.");
    const wrapped = withSentryCallable("createQuote", async () => {
      throw boom;
    });

    await expect(wrapped(callable({ uid: "u1", tenantId: "acme" }))).rejects.toBe(boom);

    expect(captureException).toHaveBeenCalledWith(boom, {
      tags: { function: "createQuote", tenantId: "acme" },
      user: { id: "u1" },
      extra: undefined,
    });
    expect(flush).toHaveBeenCalledWith(SENTRY_FLUSH_TIMEOUT_MS);
  });

  it.each([
    "invalid-argument",
    "permission-denied",
    "not-found",
    "already-exists",
    "failed-precondition",
    "resource-exhausted",
    "unauthenticated",
    "deadline-exceeded",
  ] as const)("doesn't report an expected HttpsError (%s)", async (code) => {
    const wrapped = withSentryCallable("voidInvoice", async () => {
      throw new HttpsError(code, "expected");
    });
    await expect(wrapped(callable({ uid: "u1", tenantId: "acme" }))).rejects.toMatchObject({
      code,
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it.each(["internal", "unknown", "data-loss", "unavailable"] as const)(
    "reports an HttpsError that signals a fault (%s)",
    async (code) => {
      const wrapped = withSentryCallable("createInvoice", async () => {
        throw new HttpsError(code, "fault");
      });
      await expect(wrapped(callable({ uid: "u1", tenantId: "acme" }))).rejects.toMatchObject({
        code,
      });
      expect(captureException).toHaveBeenCalledTimes(1);
    },
  );

  it("tags a public call with no tenant and no user", async () => {
    const wrapped = withSentryCallable("sendPortalSignInLink", async () => {
      throw new Error("boom");
    });
    await expect(wrapped(callable(null))).rejects.toThrow("boom");
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { function: "sendPortalSignInLink", tenantId: "none" },
      user: undefined,
      extra: undefined,
    });
  });

  it("rethrows the original error even if Sentry itself fails", async () => {
    captureException.mockImplementation(() => {
      throw new Error("sentry down");
    });
    const boom = new Error("original");
    const wrapped = withSentryCallable("createQuote", async () => {
      throw boom;
    });
    await expect(wrapped(callable({ uid: "u1", tenantId: "acme" }))).rejects.toBe(boom);

    captureException.mockReset();
    flush.mockRejectedValue(new Error("flush timeout"));
    await expect(wrapped(callable({ uid: "u1", tenantId: "acme" }))).rejects.toBe(boom);
  });
});

describe("withSentryEvent (O-01)", () => {
  it("tags a Firestore trigger error with the tenant from the document path", async () => {
    const boom = new Error("receipt render failed");
    const wrapped = withSentryEvent("onInvoicePaid", async () => {
      throw boom;
    });
    const event = { params: { tenantId: "acme", invoiceId: "INV-0001" } };

    await expect(wrapped(event)).rejects.toBe(boom);
    expect(captureException).toHaveBeenCalledWith(boom, {
      tags: { function: "onInvoicePaid", tenantId: "acme" },
      user: undefined,
      extra: { params: { tenantId: "acme", invoiceId: "INV-0001" } },
    });
  });

  it("tags a scheduled function error with no tenant", async () => {
    const wrapped = withSentryEvent("processRecurringInvoices", async () => {
      throw new Error("query failed");
    });
    await expect(wrapped({ scheduleTime: "2026-09-14T06:00:00Z" })).rejects.toThrow(
      "query failed",
    );
    expect(captureException.mock.calls[0][1]).toMatchObject({
      tags: { function: "processRecurringInvoices", tenantId: "none" },
      extra: undefined,
    });
  });

  it("does nothing extra when the handler succeeds", async () => {
    const handler = vi.fn();
    await withSentryEvent("recheckPendingDomains", handler)({});
    expect(handler).toHaveBeenCalledTimes(1);
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe("withSentryRequest and reportError (O-01)", () => {
  it("reports and rethrows an HTTP handler error", async () => {
    const boom = new Error("SNS parse failed");
    const wrapped = withSentryRequest("sesEventsWebhook", async () => {
      throw boom;
    });
    await expect(wrapped({}, {})).rejects.toBe(boom);
    expect(captureException.mock.calls[0][1]).toMatchObject({
      tags: { function: "sesEventsWebhook", tenantId: "none" },
    });
  });

  it("reportError skips expected HttpsErrors", async () => {
    await reportError(new HttpsError("not-found", "gone"), { functionName: "x" });
    expect(captureException).not.toHaveBeenCalled();
    expect(shouldReport(new TypeError("bad"))).toBe(true);
  });
});
