"use client";

import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { getClientStorage } from "@/lib/firebase/client";

// Owner/admin uploads a logo or favicon directly to Storage. Storage rules
// (`tenants/{id}/{fileName}` limited to `logo|favicon` + an image extension)
// gate by tenantId+role+size+contentType. Caller is responsible for then
// writing the returned URL to `meta.logoUrl` / `meta.faviconUrl` via the
// updateTenantBranding callable.
//
// A replacement goes to the same path and Storage keeps the object's download
// token, so getDownloadURL returns the same URL as last time, and pages already
// showing the old image kept it (F-10). The URL therefore carries the upload's
// object generation, new on every upload, as `v`: Storage ignores the
// parameter, but the saved URL changes and every page loads the new file.
export async function uploadBrandingAsset(
  tenantId: string,
  kind: "logo" | "favicon",
  file: File,
): Promise<string> {
  const ext = extensionFor(file);
  const path = `tenants/${tenantId}/${kind}.${ext}`;
  const storageRef = ref(getClientStorage(), path);
  const { metadata } = await uploadBytes(storageRef, file, { contentType: file.type });
  return versionedDownloadUrl(await getDownloadURL(storageRef), metadata.generation);
}

/** A download URL with `v` set to the object's generation. */
export function versionedDownloadUrl(downloadUrl: string, generation: string): string {
  const url = new URL(downloadUrl);
  url.searchParams.set("v", String(generation));
  return url.toString();
}

// Must stay in sync with isBrandingFileName / isBrandingImage in storage.rules.
const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

function extensionFor(file: File): string {
  const ext = EXTENSION_BY_TYPE[file.type];
  if (!ext) throw new Error("Use a PNG, JPG, WebP, SVG, or ICO image.");
  return ext;
}
