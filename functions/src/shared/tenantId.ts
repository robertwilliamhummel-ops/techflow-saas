import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./admin";

const MAX_SUFFIX = 100;

// C4 from round-3 audit. Slug with a collision suffix: stable human-readable
// IDs that show up in Firestore paths, Stripe metadata, Sentry tags, and
// support conversations.
export function toSlug(businessName: string): string {
  const base = String(businessName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base.length > 0 ? base : "tenant";
}

// Picks the first free candidate inside the caller's transaction. Reading alone
// doesn't reserve it (A-12: the old version read in a transaction of its own
// and wrote nothing, so two signups with the same business name both got the
// same id and the second overwrote the first). The caller must claim the id by
// creating tenants/{id}/meta/settings with tx.create() in the same
// transaction; that commit fails if another signup claimed it first.
export async function pickTenantId(
  tx: FirebaseFirestore.Transaction,
  businessName: string,
): Promise<string> {
  const base = toSlug(businessName);
  for (let suffix = 0; suffix < MAX_SUFFIX; suffix++) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    const snap = await tx.get(db.doc(`tenants/${candidate}/meta/settings`));
    if (!snap.exists) return candidate;
  }
  throw new HttpsError(
    "resource-exhausted",
    "Could not generate a unique tenant ID after 100 attempts.",
  );
}
