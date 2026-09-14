// Logo snapshots (Phase 6, A-06, D7).
//
// When an invoice or quote is created, the tenant's current logo is copied to
// an immutable object in Storage and frozen on the tenantSnapshot as:
//   - `logoUrl`: a token URL to that copy. Emails and the portal link to it,
//     and PDF renders inline it as a data URL (pdfLogoDataUrl), because the
//     pdf-service fetches nothing over the network.
//   - `logoContentType`: its MIME type.
//
// D7: the snapshot no longer carries a base64 copy of the logo. Browsers read
// whole documents (the Firestore web SDK can't select fields), so a logo of up
// to 500 KB on every invoice rode along on every dashboard and list read. PDFs
// still render the logo a document was issued with, because the copy is never
// overwritten or deleted.
//
// The copy lives at tenants/{tenantId}/snapshots/logos/{sha256}.{ext}. The path
// comes from the bytes, so an object is never overwritten with other content,
// and its download token comes from the tenant and hash, so two documents
// created at once with the same logo can't rotate a token the other stored.
// Clients can't write or delete under snapshots/ (storage.rules); the token URL
// is public by design, like any image in an email.

import { createHash } from "node:crypto";
import { HttpsError } from "firebase-functions/v2/https";
import { getStorage } from "firebase-admin/storage";

export const LOGO_MAX_BYTES = 500 * 1024;

const STORAGE_DOWNLOAD_ORIGIN = "https://firebasestorage.googleapis.com";

const SNAPSHOT_LOGO_PATH =
  /^tenants\/([^/]+)\/snapshots\/logos\/[a-f0-9]{64}\.[a-z]+$/;

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
  logoUrl: string | null;
  logoContentType: string | null;
}

interface FetchedLogo {
  bytes: Buffer;
  contentType: string;
}

// The Storage emulator's origin in tests and local runs — the same
// STORAGE_EMULATOR_HOST (scheme included) that downloadUrlFor builds URLs from.
function storageEmulatorOrigin(): string | null {
  const host = process.env.STORAGE_EMULATOR_HOST;
  if (!host) return null;
  try {
    return new URL(host).origin;
  } catch {
    return null;
  }
}

function isStorageEmulatorUrl(url: string): boolean {
  const origin = storageEmulatorOrigin();
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

async function fetchLogoOrThrow(logoUrl: string): Promise<FetchedLogo> {
  if (!/^https:\/\//i.test(logoUrl) && !isStorageEmulatorUrl(logoUrl)) {
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
    (process.env.STORAGE_EMULATOR_HOST || STORAGE_DOWNLOAD_ORIGIN) + "/v0";
  return `${endpoint}/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

// Fetches the logo and returns it as a base64 data URL. Throws on any failure.
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

// Freezes the tenant's current logo onto a snapshot, or clears it when the
// tenant has no logo.
export async function applyLogoToSnapshot(
  snapshot: SnapshotLogoFields,
  tenantId: string,
  sourceUrl: string | null | undefined,
): Promise<void> {
  const fields: SnapshotLogoFields = sourceUrl
    ? await snapshotLogoOrThrow(tenantId, sourceUrl)
    : { logoUrl: null, logoContentType: null };
  snapshot.logoUrl = fields.logoUrl;
  snapshot.logoContentType = fields.logoContentType;
  // D7: a base64 copy is never stored, whatever the snapshot was built from.
  delete (snapshot as SnapshotLogoFields & { logo?: unknown }).logo;
}

/**
 * Whether a URL is one of this tenant's snapshot copies: a Storage download URL
 * (or the emulator's) for tenants/{tenantId}/snapshots/logos/{sha256}.{ext}.
 */
export function isSnapshotLogoUrl(url: string, tenantId: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const origins = [STORAGE_DOWNLOAD_ORIGIN, storageEmulatorOrigin()];
  if (!origins.includes(parsed.origin)) return false;
  // /v0/b/{bucket}/o/{object path, URL-encoded}
  const match = /^\/v0\/b\/[^/]+\/o\/([^/]+)$/.exec(parsed.pathname);
  if (!match) return false;
  let objectPath: string;
  try {
    objectPath = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  const path = SNAPSHOT_LOGO_PATH.exec(objectPath);
  return path !== null && path[1] === tenantId;
}

/**
 * The document's logo as a data URL for the pdf-service (D7), or null when the
 * document has no logo. Only this tenant's snapshot copies are fetched.
 */
export async function pdfLogoDataUrl(
  snapshot: { logoUrl?: unknown } | null | undefined,
  tenantId: string,
): Promise<string | null> {
  const url = snapshot?.logoUrl;
  if (typeof url !== "string" || url === "") return null;
  if (!isSnapshotLogoUrl(url, tenantId)) {
    throw new HttpsError(
      "failed-precondition",
      "This document's logo isn't one of its business's stored logo copies.",
    );
  }
  try {
    return await inlineLogoOrThrow(url);
  } catch (err) {
    throw new HttpsError(
      "unavailable",
      `Couldn't load this document's logo. Try again. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

// The logo for an email header: the immutable https copy when its format is
// email-safe, otherwise null (the layout shows the business name). Emails only
// ever link to the hosted copy; they never embed image data.
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
