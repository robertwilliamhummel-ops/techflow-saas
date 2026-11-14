import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { deleteApp, initializeApp } from "firebase/app";
import { getFunctions, httpsCallable } from "firebase/functions";
import { callableOutcomeUnknown, saveFailure } from "../firebase/callableErrors";

// The real Functions SDK against a stubbed fetch, so these are the errors the
// new invoice and quote form actually receives.
const app = initializeApp({ projectId: "demo-test", apiKey: "test", appId: "test" }, "callable-errors-test");
const functions = getFunctions(app, "northamerica-northeast2");

async function failedCreate(
  respond: () => Promise<Response>,
  options?: { timeout: number },
): Promise<unknown> {
  vi.stubGlobal("fetch", vi.fn(respond));
  try {
    await httpsCallable(functions, "createInvoice", options)({});
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to fail");
}

function errorResponse(status: number, body?: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await deleteApp(app);
});

describe("saveFailure", () => {
  it("can't confirm a save when the connection fails", async () => {
    const err = await failedCreate(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(err).toMatchObject({ code: "functions/internal" });
    expect(saveFailure(err, "fallback")).toEqual({ kind: "unconfirmed" });
  });

  it("can't confirm a save when the function crashes before answering", async () => {
    // Out of memory after the write: Cloud Run answers 500, or 503, with no
    // callable body.
    for (const status of [500, 503, 502]) {
      const err = await failedCreate(() => errorResponse(status));
      expect(saveFailure(err, "fallback")).toEqual({ kind: "unconfirmed" });
    }
    // An unhandled error inside the function.
    const err = await failedCreate(() =>
      errorResponse(500, { error: { status: "INTERNAL", message: "INTERNAL" } }),
    );
    expect(saveFailure(err, "fallback")).toEqual({ kind: "unconfirmed" });
  });

  it("can't confirm a save when the page stops waiting", async () => {
    const err = await failedCreate(() => new Promise<Response>(() => {}), { timeout: 5 });
    expect(err).toMatchObject({ code: "functions/deadline-exceeded" });
    expect(saveFailure(err, "fallback")).toEqual({ kind: "unconfirmed" });
  });

  it("passes on the function's own refusal: nothing was saved", async () => {
    const refusals: Array<[number, string, string]> = [
      [400, "INVALID_ARGUMENT", "customer.email must be a valid address."],
      [403, "PERMISSION_DENIED", "Feature 'invoices' is not enabled for this tenant."],
      [400, "FAILED_PRECONDITION", "Logo exceeds 500KB. Re-upload a smaller version in settings."],
      [429, "RESOURCE_EXHAUSTED", "Too many requests."],
      [401, "UNAUTHENTICATED", "Sign in required."],
    ];
    for (const [status, code, message] of refusals) {
      const err = await failedCreate(() => errorResponse(status, { error: { status: code, message } }));
      expect(saveFailure(err, "fallback")).toEqual({ kind: "rejected", message });
    }
  });

  it("falls back to its own words when a refusal has none", () => {
    const err = Object.assign(new Error(""), { code: "functions/invalid-argument" });
    expect(saveFailure(err, "Couldn't save the quote. Try again.")).toEqual({
      kind: "rejected",
      message: "Couldn't save the quote. Try again.",
    });
  });
});

describe("callableOutcomeUnknown", () => {
  it("is unknown for failures that may come after the work, and for errors without a code", () => {
    for (const err of [
      { code: "functions/internal" },
      { code: "functions/unknown" },
      { code: "functions/unavailable" },
      { code: "functions/deadline-exceeded" },
      { code: "functions/cancelled" },
      { code: "functions/data-loss" },
      new Error("offline"),
      null,
    ]) {
      expect(callableOutcomeUnknown(err)).toBe(true);
    }
  });

  it("is known for the function's own refusals", () => {
    for (const code of [
      "invalid-argument",
      "not-found",
      "already-exists",
      "permission-denied",
      "resource-exhausted",
      "failed-precondition",
      "aborted",
      "out-of-range",
      "unimplemented",
      "unauthenticated",
    ]) {
      expect(callableOutcomeUnknown({ code: `functions/${code}` })).toBe(false);
    }
  });
});
