// Stripe webhook idempotency (A-03).
//
// Stripe retries a delivery that doesn't get a 2xx for up to three days in live
// mode, and can deliver the same event more than once, so each event id moves
// through stripeEvents/{eventId}.status:
//
//   claim    — the first delivery, a retry after a failure, or a retry after an
//              expired lease marks the event `processing`. A copy that arrives
//              while a run holds a live lease is told to come back later (the
//              route answers 409, which Stripe retries).
//   complete — after the handler's writes succeed: `done`. Later copies are
//              acknowledged as duplicates.
//   release  — a handler that throws marks the event `failed`; the route answers
//              500 and Stripe's retry runs it again.
//
// Because a run can repeat (release, lease expiry), handlers must be safe to run
// more than once: merge writes, deterministic incident ids, idempotency keys on
// Stripe calls.

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

export interface StripeEventMeta {
  type: string;
  account: string | null;
  livemode: boolean;
}

export type ClaimResult = "claimed" | "duplicate" | "in-progress";

// Longer than any webhook run. A run that crashes or times out without
// releasing can be retried once its lease lapses.
export const PROCESSING_LEASE_MS = 5 * 60 * 1000;

// Past Stripe's 3-day automatic and 30-day manual resend windows; enforced by
// the Firestore TTL policy on `expireAt`.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface StripeEventDoc {
  status?: "processing" | "done" | "failed";
  attempts?: number;
  leaseExpiresAtMs?: number | null;
  receivedAt?: unknown;
}

function eventRef(eventId: string) {
  return getAdminDb().doc(`stripeEvents/${eventId}`);
}

export async function claimStripeEvent(
  eventId: string,
  meta: StripeEventMeta,
  now: number = Date.now(),
): Promise<ClaimResult> {
  const db = getAdminDb();
  const ref = eventRef(eventId);
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? (snap.data() as StripeEventDoc) : null;

    if (prev?.status === "done") return "duplicate";
    if (
      prev?.status === "processing" &&
      typeof prev.leaseExpiresAtMs === "number" &&
      prev.leaseExpiresAtMs > now
    ) {
      return "in-progress";
    }

    tx.set(ref, {
      type: meta.type,
      account: meta.account,
      livemode: meta.livemode,
      status: "processing",
      attempts: (prev?.attempts ?? 0) + 1,
      leaseExpiresAtMs: now + PROCESSING_LEASE_MS,
      receivedAt: prev?.receivedAt ?? FieldValue.serverTimestamp(),
      claimedAt: FieldValue.serverTimestamp(),
      expireAt: Timestamp.fromMillis(now + RETENTION_MS),
    });
    return "claimed";
  });
}

export async function completeStripeEvent(eventId: string): Promise<void> {
  await eventRef(eventId).set(
    {
      status: "done",
      leaseExpiresAtMs: null,
      processedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

export async function releaseStripeEvent(
  eventId: string,
  error: string,
): Promise<void> {
  await eventRef(eventId).set(
    {
      status: "failed",
      leaseExpiresAtMs: null,
      lastError: error.slice(0, 500),
      failedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}
