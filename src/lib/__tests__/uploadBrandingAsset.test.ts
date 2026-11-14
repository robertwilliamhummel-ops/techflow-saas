import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake Storage that behaves like production on an overwrite: the object gets
// a new generation but keeps its download token, so getDownloadURL repeats.
const storage = vi.hoisted(() => ({
  generation: "1",
  uploads: [] as Array<{ path: string; contentType: string | undefined }>,
}));

vi.mock("@/lib/firebase/client", () => ({ getClientStorage: () => ({}) }));

vi.mock("firebase/storage", () => ({
  ref: (_storage: unknown, path: string) => ({ fullPath: path }),
  uploadBytes: async (
    storageRef: { fullPath: string },
    _file: unknown,
    metadata: { contentType?: string },
  ) => {
    storage.uploads.push({ path: storageRef.fullPath, contentType: metadata.contentType });
    return { ref: storageRef, metadata: { generation: storage.generation } };
  },
  getDownloadURL: async (storageRef: { fullPath: string }) =>
    `https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/${encodeURIComponent(storageRef.fullPath)}?alt=media&token=1b2c3d4e-0000-4000-a000-000000000000`,
}));

import { uploadBrandingAsset, versionedDownloadUrl } from "../storage/uploadBrandingAsset";

const png = () => new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" });

beforeEach(() => {
  storage.uploads = [];
});

describe("uploadBrandingAsset", () => {
  it("gives a replaced logo a new URL, so pages showing the old one load it", async () => {
    storage.generation = "1731500000000001";
    const first = await uploadBrandingAsset("acme", "logo", png());
    storage.generation = "1731500000000002";
    const second = await uploadBrandingAsset("acme", "logo", png());

    expect(storage.uploads).toEqual([
      { path: "tenants/acme/logo.png", contentType: "image/png" },
      { path: "tenants/acme/logo.png", contentType: "image/png" },
    ]);
    expect(first).toBe(
      "https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/tenants%2Facme%2Flogo.png?alt=media&token=1b2c3d4e-0000-4000-a000-000000000000&v=1731500000000001",
    );
    expect(second).not.toBe(first);
    expect(new URL(second).searchParams.get("v")).toBe("1731500000000002");
  });

  it("versions a replaced favicon the same way", async () => {
    storage.generation = "7";
    const url = await uploadBrandingAsset("acme", "favicon", png());
    expect(storage.uploads[0].path).toBe("tenants/acme/favicon.png");
    expect(new URL(url).searchParams.get("v")).toBe("7");
  });

  it("refuses a file type the Storage rules don't allow, before uploading", async () => {
    const gif = new File([new Uint8Array([71, 73, 70])], "logo.gif", { type: "image/gif" });
    await expect(uploadBrandingAsset("acme", "logo", gif)).rejects.toThrow(
      "Use a PNG, JPG, WebP, SVG, or ICO image.",
    );
    expect(storage.uploads).toEqual([]);
  });
});

describe("versionedDownloadUrl", () => {
  it("keeps the download URL Storage serves: path, alt and token unchanged", () => {
    const url = new URL(
      versionedDownloadUrl(
        "https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/tenants%2Facme%2Flogo.svg?alt=media&token=abc-123",
        "42",
      ),
    );
    expect(url.origin + url.pathname).toBe(
      "https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/tenants%2Facme%2Flogo.svg",
    );
    expect(url.searchParams.get("alt")).toBe("media");
    expect(url.searchParams.get("token")).toBe("abc-123");
    expect(url.searchParams.get("v")).toBe("42");
  });

  it("replaces an earlier version rather than adding a second one", () => {
    const url = versionedDownloadUrl(
      "http://127.0.0.1:9199/v0/b/demo/o/tenants%2Facme%2Flogo.png?alt=media&token=t&v=1",
      "2",
    );
    expect(url).toBe("http://127.0.0.1:9199/v0/b/demo/o/tenants%2Facme%2Flogo.png?alt=media&token=t&v=2");
  });
});
