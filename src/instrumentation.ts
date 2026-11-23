// Server-side Sentry init for Next.js (App Router instrumentation hook).
// DSN is read from env at request time. With no DSN, Sentry no-ops cleanly,
// so this file is safe to ship before a Sentry project exists. Errors only,
// with pay tokens and sign-in codes stripped before sending
// (src/lib/sentry/scrub.ts).

import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/sentry/scrub";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    Sentry.init(sentryOptions(process.env.SENTRY_DSN));
  }
}

export const onRequestError = Sentry.captureRequestError;
