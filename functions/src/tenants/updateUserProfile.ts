import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db, FieldValue } from "../shared/admin";
import { readClaims } from "../shared/auth";

interface Input {
  displayName?: unknown;
}

// Whitelisted-fields self-update. C6 from round-3 audit — the users/{uid} doc
// carries tenantId and role; letting clients write it directly would allow
// self-spoofing. All writes go through this callable.
export async function updateUserProfileHandler(
  request: CallableRequest<Input>,
): Promise<{ ok: true }> {
  const claims = readClaims(request);

  const data = (request.data as Input | undefined) ?? {};
  const patch: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };

  if ("displayName" in data) {
    const raw = data.displayName;
    if (raw === null) {
      patch.displayName = null;
    } else {
      const name = String(raw ?? "").trim();
      if (name.length === 0 || name.length > 80) {
        throw new HttpsError(
          "invalid-argument",
          "displayName must be 1–80 characters or null.",
        );
      }
      patch.displayName = name;
    }
  }

  if (Object.keys(patch).length === 1) {
    // Only updatedAt — nothing to change.
    throw new HttpsError("invalid-argument", "No editable fields supplied.");
  }

  await db.doc(`users/${claims.uid}`).set(patch, { merge: true });
  return { ok: true };
}

export const updateUserProfile = onCall<Input>(updateUserProfileHandler);
