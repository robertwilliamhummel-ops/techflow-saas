"use client";

import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { getClientStorage } from "@/lib/firebase/client";

// Owner/admin uploads a logo or favicon directly to Storage. Storage rules
// (`tenants/{id}/{fileName}` limited to `logo|favicon` + an image extension)
// gate by tenantId+role+size+contentType. Caller is responsible for then
// writing the returned URL to `meta.logoUrl` / `meta.faviconUrl` via the
// updateTenantBranding callable.
export async function uploadBrandingAsset(
  tenantId: string,
  kind: "logo" | "favicon",
  file: File,
): Promise<string> {
  const ext = extensionFor(file);
  const path = `tenants/${tenantId}/${kind}.${ext}`;
  const storageRef = ref(getClientStorage(), path);
  await uploadBytes(storageRef, file, { contentType: file.type });
  return await getDownloadURL(storageRef);
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
