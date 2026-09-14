import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfLoadError } from "@/lib/pdf/loadDoc";
import {
  PDF_LOGO_MAX_BYTES,
  isSnapshotLogoUrl,
  pdfLogoDataUrl,
  withPdfLogo,
} from "@/lib/pdf/logo";

const HASH = "a".repeat(64);

function storageUrl(
  objectPath: string,
  origin = "https://firebasestorage.googleapis.com",
): string {
  return `${origin}/v0/b/techflow-saas-prod.appspot.com/o/${encodeURIComponent(objectPath)}?alt=media&token=abc`;
}

const ACME_LOGO = storageUrl(`tenants/acme/snapshots/logos/${HASH}.png`);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const ORIGINAL_FETCH = globalThis.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.NEXT_PUBLIC_USE_EMULATORS;
});

describe("isSnapshotLogoUrl", () => {
  it("accepts the tenant's own snapshot copy", () => {
    expect(isSnapshotLogoUrl(ACME_LOGO, "acme")).toBe(true);
  });

  it("refuses another tenant's copy", () => {
    expect(isSnapshotLogoUrl(ACME_LOGO, "other")).toBe(false);
  });

  it("refuses the tenant's mutable uploads and other Storage paths", () => {
    expect(isSnapshotLogoUrl(storageUrl("tenants/acme/logo.png"), "acme")).toBe(false);
    expect(
      isSnapshotLogoUrl(storageUrl(`tenants/acme/snapshots/logos/../../x/${HASH}.png`), "acme"),
    ).toBe(false);
  });

  it("refuses any other host, and plain http", () => {
    expect(isSnapshotLogoUrl(`https://evil.example/tenants/acme/snapshots/logos/${HASH}.png`, "acme")).toBe(false);
    expect(
      isSnapshotLogoUrl(ACME_LOGO.replace("https://", "http://"), "acme"),
    ).toBe(false);
    expect(isSnapshotLogoUrl("not a url", "acme")).toBe(false);
  });

  it("accepts the Storage emulator only when the app runs against emulators", () => {
    const emulatorLogo = storageUrl(
      `tenants/acme/snapshots/logos/${HASH}.png`,
      "http://127.0.0.1:9199",
    );
    expect(isSnapshotLogoUrl(emulatorLogo, "acme")).toBe(false);
    process.env.NEXT_PUBLIC_USE_EMULATORS = "1";
    expect(isSnapshotLogoUrl(emulatorLogo, "acme")).toBe(true);
  });
});

describe("pdfLogoDataUrl", () => {
  it("is null when the document has no logo, without fetching", async () => {
    await expect(pdfLogoDataUrl({ logoUrl: null }, "acme")).resolves.toBeNull();
    await expect(pdfLogoDataUrl({}, "acme")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the copy as a data URL", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
    );
    await expect(pdfLogoDataUrl({ logoUrl: ACME_LOGO }, "acme")).resolves.toBe(
      `data:image/png;base64,${PNG.toString("base64")}`,
    );
    expect(fetchMock.mock.calls[0][0]).toBe(ACME_LOGO);
  });

  it("refuses a URL that isn't the tenant's copy (409) without fetching", async () => {
    await expect(
      pdfLogoDataUrl({ logoUrl: "https://evil.example/logo.png" }, "acme"),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["the fetch fails", () => fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"))],
    ["Storage answers an error", () => fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }))],
    [
      "the response isn't an image",
      () =>
        fetchMock.mockResolvedValueOnce(
          new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
        ),
    ],
    [
      "the image is over the size limit",
      () =>
        fetchMock.mockResolvedValueOnce(
          new Response(Buffer.alloc(PDF_LOGO_MAX_BYTES + 1), {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        ),
    ],
  ])("answers 502 when %s", async (_label, arrange) => {
    arrange();
    const error = await pdfLogoDataUrl({ logoUrl: ACME_LOGO }, "acme").catch((e) => e);
    expect(error).toBeInstanceOf(PdfLoadError);
    expect(error).toMatchObject({ status: 502 });
  });
});

describe("withPdfLogo", () => {
  it("adds the inlined logo and keeps the rest of the request", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
    );
    const body = { snapshot: { name: "Acme", logoUrl: ACME_LOGO }, data: { invoiceId: "INV-1" } };

    const result = await withPdfLogo(body, "acme");

    expect(result.data).toEqual({ invoiceId: "INV-1" });
    expect(result.snapshot).toMatchObject({
      name: "Acme",
      logo: `data:image/png;base64,${PNG.toString("base64")}`,
    });
    expect(body.snapshot).not.toHaveProperty("logo");
  });
});
