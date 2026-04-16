import { createHash, randomBytes } from "node:crypto";

// Opaque random token + SHA-256 hash for server-side equality checks.
// The raw token never persists in Firestore — only the hash does, so a DB
// leak can't be used to accept invites.
export interface OpaqueToken {
  raw: string;
  hash: string;
}

export function generateOpaqueToken(bytes = 32): OpaqueToken {
  const raw = randomBytes(bytes).toString("base64url");
  const hash = hashToken(raw);
  return { raw, hash };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}
