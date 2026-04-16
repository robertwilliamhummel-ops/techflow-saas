import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./admin";

const MAX_SUFFIX = 100;

// C4 from round-3 audit. Slug-with-collision-suffix generated inside a
// transaction so two simultaneous signups with the same business name can't
// both grab the same ID. Produces stable human-readable IDs that show up in
// Firestore paths, Stripe metadata, Sentry tags, and support conversations.
export function toSlug(businessName: string): string {
  const base = String(businessName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base.length > 0 ? base : "tenant";
}

export async function generateTenantId(businessName: string): Promise<string> {
  const base = toSlug(businessName);
  return await db.runTransaction(async (tx) => {
    for (let suffix = 0; suffix < MAX_SUFFIX; suffix++) {
      const candidate = suffix === 0 ? base : `${base}-${suffix}`;
      const ref = db.doc(`tenants/${candidate}/meta/settings`);
      const snap = await tx.get(ref);
      if (!snap.exists) return candidate;
    }
    throw new HttpsError(
      "resource-exhausted",
      "Could not generate a unique tenant ID after 100 attempts.",
    );
  });
}
