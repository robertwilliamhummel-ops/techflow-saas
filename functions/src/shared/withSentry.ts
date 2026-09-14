// Error reporting for Cloud Functions (O-01).
//
// Every deployed function's handler goes through one of these wrappers
// (test/shared/sentryCoverage.test.ts checks), so an unexpected error reaches
// Sentry tagged with the function name, tenantId, and uid. The tags go on the
// event itself rather than a shared scope, so concurrent requests on one
// instance can't mix them up.
//
// Expected HttpsErrors (bad input, permissions, not found, rate limits) are a
// callable's normal answers and aren't reported; internal-type errors and
// anything that isn't an HttpsError are. The error is always rethrown, so the
// function behaves exactly as before, and reporting can never throw instead.
// Sentry is flushed (up to 2 s) before rethrowing: Cloud Functions can
// throttle an instance once it has responded, which would strand a queued
// event.

import * as Sentry from "@sentry/node";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";

export const SENTRY_FLUSH_TIMEOUT_MS = 2000;

const REPORTED_HTTPS_CODES = new Set(["internal", "unknown", "data-loss", "unavailable"]);

export interface ErrorContext {
  functionName: string;
  tenantId?: string | null;
  uid?: string | null;
  extra?: Record<string, unknown>;
}

export function shouldReport(err: unknown): boolean {
  return !(err instanceof HttpsError) || REPORTED_HTTPS_CODES.has(err.code);
}

// Also for catch blocks that deliberately swallow an error but still mean a
// bug (e.g. the recurring processor's per-template safety net).
export async function reportError(err: unknown, context: ErrorContext): Promise<void> {
  if (!shouldReport(err)) return;
  try {
    Sentry.captureException(err, {
      tags: {
        function: context.functionName,
        tenantId: context.tenantId ?? "none",
      },
      user: context.uid ? { id: context.uid } : undefined,
      extra: context.extra,
    });
    await Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS);
  } catch {
    // Reporting must never change what the function does.
  }
}

export function withSentryCallable<T, R>(
  functionName: string,
  handler: (request: CallableRequest<T>) => R | Promise<R>,
): (request: CallableRequest<T>) => Promise<R> {
  return async (request) => {
    try {
      return await handler(request);
    } catch (err) {
      const tenantId = (request.auth?.token as { tenantId?: unknown } | undefined)
        ?.tenantId;
      await reportError(err, {
        functionName,
        tenantId: typeof tenantId === "string" ? tenantId : null,
        uid: request.auth?.uid ?? null,
      });
      throw err;
    }
  };
}

// Firestore triggers (event.params.tenantId) and scheduled functions.
export function withSentryEvent<E extends object>(
  functionName: string,
  handler: (event: E) => unknown,
): (event: E) => Promise<void> {
  return async (event) => {
    try {
      await handler(event);
    } catch (err) {
      const params = (event as { params?: Record<string, string> }).params;
      await reportError(err, {
        functionName,
        tenantId: params?.tenantId ?? null,
        extra: params ? { params } : undefined,
      });
      throw err;
    }
  };
}

export function withSentryRequest<Req, Res>(
  functionName: string,
  handler: (req: Req, res: Res) => unknown,
): (req: Req, res: Res) => Promise<void> {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      await reportError(err, { functionName });
      throw err;
    }
  };
}
