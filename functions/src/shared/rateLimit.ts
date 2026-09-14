// Per-user rate limits for costly or outward-facing callables (R-04).
//
// A transactional counter per user and action in rateLimits/{uid}_{action}: a
// fixed window that starts with the first call, so a buggy retry loop or a
// scripted account can't burn through the SES sending quota or keep Cloud Run
// rendering PDFs. Counters are removed by the TTL policy on `expireAt`. App
// Check (globalOptions.ts) stops calls that don't come from the app at all;
// this stops one signed-in caller from overusing it.

import { HttpsError } from "firebase-functions/v2/https";
import { db, Timestamp } from "./admin";

export interface RateLimit {
  action: string;
  max: number;
  windowMs: number;
}

const HOUR_MS = 60 * 60 * 1000;
const COUNTER_TTL_MS = 24 * HOUR_MS;

export const RATE_LIMITS = {
  // sendInvoiceEmail + sendQuoteEmail share one budget (R4: 50 an hour).
  sendEmail: { action: "send-email", max: 50, windowMs: HOUR_MS },
  // previewInvoicePDF + previewQuotePDF — each preview is a Cloud Run render.
  pdfPreview: { action: "pdf-preview", max: 60, windowMs: HOUR_MS },
  // createInvitation — each invitation emails someone outside the business.
  invitation: { action: "invitation", max: 20, windowMs: HOUR_MS },
} as const satisfies Record<string, RateLimit>;

export async function enforceRateLimit(
  uid: string,
  limit: RateLimit,
): Promise<void> {
  const ref = db.doc(`rateLimits/${uid}_${limit.action}`);

  const retryAfterMs = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const d = snap.data() as
      | { windowStartedAt?: Timestamp; count?: number }
      | undefined;

    const startMs = d?.windowStartedAt?.toMillis() ?? 0;
    const inWindow = now - startMs < limit.windowMs;
    const count = inWindow ? (d?.count ?? 0) : 0;
    if (count >= limit.max) return startMs + limit.windowMs - now;

    const windowStartMs = inWindow ? startMs : now;
    tx.set(ref, {
      uid,
      action: limit.action,
      windowStartedAt: Timestamp.fromMillis(windowStartMs),
      count: count + 1,
      expireAt: Timestamp.fromMillis(windowStartMs + limit.windowMs + COUNTER_TTL_MS),
    });
    return 0;
  });

  if (retryAfterMs > 0) {
    const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
    throw new HttpsError(
      "resource-exhausted",
      `Too many requests. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    );
  }
}
