// D7 — invoices and quotes store only the URL of their immutable logo copy
// (tenants/{tenantId}/snapshots/logos/{sha256}.{ext}). The pdf-service fetches
// nothing over the network, so the PDF routes inline the logo as a data URL
// here, once the caller is authorized. Mirrors pdfLogoDataUrl in
// functions/src/shared/logo.ts.

import { PdfLoadError } from "./loadDoc";

// LOGO_MAX_BYTES in functions/src/shared/logo.ts.
export const PDF_LOGO_MAX_BYTES = 500 * 1024;

const STORAGE_ORIGIN = "https://firebasestorage.googleapis.com";
// Local development against the Storage emulator (src/lib/firebase/client.ts).
const EMULATOR_ORIGINS = ["http://127.0.0.1:9199", "http://localhost:9199"];

const SNAPSHOT_LOGO_PATH =
  /^tenants\/([^/]+)\/snapshots\/logos\/[a-f0-9]{64}\.[a-z]+$/;

const LOAD_FAILED = "Couldn't load this document's logo. Try again.";

/** Whether a URL is one of this tenant's snapshot logo copies in Storage. */
export function isSnapshotLogoUrl(url: string, tenantId: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const origins =
    process.env.NEXT_PUBLIC_USE_EMULATORS === "1"
      ? [STORAGE_ORIGIN, ...EMULATOR_ORIGINS]
      : [STORAGE_ORIGIN];
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

/** The document's logo as a data URL, or null when it has no logo. */
export async function pdfLogoDataUrl(
  snapshot: Record<string, unknown>,
  tenantId: string,
): Promise<string | null> {
  const url = snapshot.logoUrl;
  if (typeof url !== "string" || url === "") return null;
  if (!isSnapshotLogoUrl(url, tenantId)) {
    throw new PdfLoadError(
      409,
      "This document's logo isn't one of its business's stored logo copies.",
    );
  }

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch {
    throw new PdfLoadError(502, LOAD_FAILED);
  }
  if (!res.ok) throw new PdfLoadError(502, LOAD_FAILED);
  const contentType = (res.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!contentType.startsWith("image/")) throw new PdfLoadError(502, LOAD_FAILED);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > PDF_LOGO_MAX_BYTES) throw new PdfLoadError(502, LOAD_FAILED);
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

/** The render request with the snapshot's logo inlined for the pdf-service. */
export async function withPdfLogo<
  T extends { snapshot: Record<string, unknown> },
>(body: T, tenantId: string): Promise<T> {
  return {
    ...body,
    snapshot: {
      ...body.snapshot,
      logo: await pdfLogoDataUrl(body.snapshot, tenantId),
    },
  };
}
