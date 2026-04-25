"use client";

import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { getClientStorage } from "@/lib/firebase/client";

// Owner/admin uploads a logo or favicon directly to Storage. Storage rules
// (`tenants/{id}/logo.{ext}`, `favicon.{ext}`) gate by tenantId+role+size+
// contentType. Caller is responsible for then writing the returned URL to
// `meta.logoUrl` / `meta.faviconUrl` via the updateTenantBranding callable.
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

function extensionFor(file: File): string {
  if (file.type === "image/png") return "png";
  if (file.type === "image/jpeg") return "jpg";
  if (file.type === "image/webp") return "webp";
  if (file.type === "image/svg+xml") return "svg";
  if (file.type === "image/x-icon" || file.type === "image/vnd.microsoft.icon")
    return "ico";
  // Fall back to whatever the file name says — Storage rule still
  // gates contentType separately.
  const nameExt = file.name.split(".").pop()?.toLowerCase();
  return nameExt && /^[a-z0-9]{2,5}$/.test(nameExt) ? nameExt : "png";
}
