// Logo snapshots (Phase 6, A-06).
//
// When an invoice or quote is created, the tenant's current logo is frozen two
// ways on its tenantSnapshot:
//   - `logo`: a base64 data URL, so the PDF renders the logo the document was
//     issued with even after the tenant replaces or deletes the file.
//   - `logoUrl`: an https URL to an immutable copy in Storage, for emails and
//     the portal. Emails can't carry the base64 logo: Gmail clips messages over
//     102 KB and a base64 logo alone can exceed that.
//
// The copy lives at tenants/{tenantId}/snapshots/logos/{sha256}.{ext}. The path
// comes from the bytes, so an object is never overwritten with other content,
// and its download token comes from the tenant and hash, so two documents
// created at once with the same logo can't rotate a token the other stored.
// Clients can't write under snapshots/ (storage.rules); the token URL is public
// by design, like any image in an email.

import { createHash } from "node:crypto";
import { HttpsError } from "firebase-functions/v2/https";
import { getStorage } from "firebase-admin/storage";

export const LOGO_MAX_BYTES = 500 * 1024;

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

// Formats email clients render reliably from a URL. SVG is left out: Gmail's
// mobile apps don't display SVG images for Google accounts, so those emails
// show the business name instead.
const EMAIL_SAFE_LOGO_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export interface SnapshotLogoFields {
  logo: string | null;
  logoUrl: string | null;
  logoContentType: string | null;
}

interface FetchedLogo {
  bytes: Buffer;
  contentType: string;
}

async function fetchLogoOrThrow(logoUrl: string): Promise<FetchedLogo> {
  if (!/^https:\/\//i.test(logoUrl)) {
    throw new HttpsError(
      "failed-precondition",
      "Logo URL must use https://. Re-upload the logo in settings.",
    );
  }
  let res: Response;
  try {
    res = await fetch(logoUrl, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    throw new HttpsError(
      "failed-precondition",
      `Logo fetch failed: ${String(err)}`,
    );
  }
  if (!res.ok) {
    throw new HttpsError(
      "failed-precondition",
      `Logo fetch returned status ${res.status}.`,
    );
  }
  const contentType = (res.headers.get("content-type") ?? "image/png")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new HttpsError(
      "failed-precondition",
      "The logo URL didn't return an image. Re-upload the logo in settings.",
    );
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > LOGO_MAX_BYTES) {
    throw new HttpsError(
      "failed-precondition",
      "Logo exceeds 500KB. Re-upload a smaller version in settings.",
    );
  }
  return { bytes, contentType };
}

function toDataUrl({ bytes, contentType }: FetchedLogo): string {
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

// UUID-shaped, like the tokens Firebase Storage issues itself.
function downloadTokenFor(tenantId: string, hash: string): string {
  const hex = createHash("sha256")
    .update(`logo-download-token:${tenantId}:${hash}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// The same URL firebase-admin's getDownloadURL builds (firebase-admin
// lib/storage/index.js), without its extra authenticated metadata read — the
// token is the one this module writes, so there is nothing to look up.
function downloadUrlFor(
  bucketName: string,
  objectPath: string,
  token: string,
): string {
  const endpoint =
    (process.env.STORAGE_EMULATOR_HOST ||
      "https://firebasestorage.googleapis.com") + "/v0";
  return `${endpoint}/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

// Fetches the logo and returns it as a base64 data URL. Throws on any failure
// so callers fail atomically rather than persisting a half-snapshot.
export async function inlineLogoOrThrow(logoUrl: string): Promise<string> {
  return toDataUrl(await fetchLogoOrThrow(logoUrl));
}

export async function snapshotLogoOrThrow(
  tenantId: string,
  sourceUrl: string,
): Promise<SnapshotLogoFields> {
  const fetched = await fetchLogoOrThrow(sourceUrl);
  const hash = createHash("sha256").update(fetched.bytes).digest("hex");
  const extension = EXTENSION_BY_TYPE[fetched.contentType] ?? "img";
  const bucket = getStorage().bucket();
  const objectPath = `tenants/${tenantId}/snapshots/logos/${hash}.${extension}`;
  const file = bucket.file(objectPath);
  const token = downloadTokenFor(tenantId, hash);

  try {
    const [exists] = await file.exists();
    if (!exists) {
      await file.save(fetched.bytes, {
        resumable: false,
        contentType: fetched.contentType,
        metadata: {
          cacheControl: "public, max-age=31536000, immutable",
          metadata: { firebaseStorageDownloadTokens: token },
        },
      });
    }
    return {
      logo: toDataUrl(fetched),
      logoUrl: downloadUrlFor(bucket.name, objectPath, token),
      logoContentType: fetched.contentType,
    };
  } catch (err) {
    throw new HttpsError(
      "unavailable",
      `Couldn't store the logo for this document. Try again. (${String(err)})`,
    );
  }
}

// Freezes the tenant's current logo onto a snapshot (both forms), or clears
// both when the tenant has no logo.
export async function applyLogoToSnapshot(
  snapshot: SnapshotLogoFields,
  tenantId: string,
  sourceUrl: string | null | undefined,
): Promise<void> {
  const fields: SnapshotLogoFields = sourceUrl
    ? await snapshotLogoOrThrow(tenantId, sourceUrl)
    : { logo: null, logoUrl: null, logoContentType: null };
  snapshot.logo = fields.logo;
  snapshot.logoUrl = fields.logoUrl;
  snapshot.logoContentType = fields.logoContentType;
}

// The logo for an email header: the immutable https copy when its format is
// email-safe, otherwise null (the layout shows the business name). Never the
// base64 logo.
export function emailLogoUrl(
  snapshot:
    | { logoUrl?: unknown; logoContentType?: unknown }
    | null
    | undefined,
): string | null {
  return typeof snapshot?.logoUrl === "string" &&
    typeof snapshot.logoContentType === "string" &&
    EMAIL_SAFE_LOGO_TYPES.has(snapshot.logoContentType)
    ? snapshot.logoUrl
    : null;
}
