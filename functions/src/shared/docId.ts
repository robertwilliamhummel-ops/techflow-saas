import { HttpsError } from "firebase-functions/v2/https";

// Ids from callers become one path segment. A "/" would address a different
// document, and Firestore reserves ids matching __.*__, so only this shape is
// accepted (auto-ids are 20 alphanumerics).
const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RESERVED = /^__.*__$/;

export function requireDocId(raw: unknown, field: string): string {
  const id = String(raw ?? "").trim();
  if (!id) {
    throw new HttpsError("invalid-argument", `${field} required.`);
  }
  if (!DOC_ID.test(id) || RESERVED.test(id)) {
    throw new HttpsError("invalid-argument", `${field} is invalid.`);
  }
  return id;
}
