// Stripe webhook idempotency sentinel — mirrors functions/src/shared/stripe.ts
// `claimStripeEvent` for the Next.js webhook routes. Separate copy because the
// Functions version imports from firebase-functions params; this one uses the
// Next-side admin SDK. Keep both in sync when adjusting the TTL or doc shape.

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

export interface StripeEventMeta {
  type: string;
  account: string | null;
  livemode: boolean;
}

// Transactional claim: returns true only for the first caller; subsequent
// redeliveries of the same event.id see the sentinel doc and bail out.
export async function claimStripeEvent(
  eventId: string,
  meta: StripeEventMeta,
): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`stripeEvents/${eventId}`);
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.set(ref, {
      type: meta.type,
      account: meta.account,
      livemode: meta.livemode,
      receivedAt: FieldValue.serverTimestamp(),
      expireAt: Timestamp.fromMillis(
        Date.now() + 30 * 24 * 60 * 60 * 1000,
      ),
    });
    return true;
  });
}
