// What a failed callable says about whether its work happened.
//
// The Functions SDK reports a network failure, and a function that crashed
// before it answered (out of memory, say), as `internal`; Cloud Run's 503 as
// `unavailable`, a 502 as `unknown`, and the client giving up as
// `deadline-exceeded`. After any of those the function may still have saved —
// on staging createInvoice wrote INV-0001 and then ran out of memory. Every
// other code is the function's own refusal, and our callables refuse before
// they write.

const OUTCOME_UNKNOWN_CODES = new Set([
  "internal",
  "unknown",
  "unavailable",
  "deadline-exceeded",
  "cancelled",
  "data-loss",
]);

/** The error's Functions code without its `functions/` prefix, if it has one. */
function bareCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code.replace(/^functions\//, "") : null;
}

/** Whether the call may have done its work even though it failed. */
export function callableOutcomeUnknown(err: unknown): boolean {
  const code = bareCode(err);
  return code === null || OUTCOME_UNKNOWN_CODES.has(code);
}

export type SaveFailure =
  | { kind: "unconfirmed" }
  | { kind: "rejected"; message: string };

/**
 * How to report a failed create: `unconfirmed` when the document may exist, so
 * the page sends the owner to check before a retry makes a duplicate; otherwise
 * `rejected` with the function's own explanation.
 */
export function saveFailure(err: unknown, fallback: string): SaveFailure {
  if (callableOutcomeUnknown(err)) return { kind: "unconfirmed" };
  return {
    kind: "rejected",
    message: err instanceof Error && err.message ? err.message : fallback,
  };
}
