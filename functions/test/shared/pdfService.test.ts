import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderViaPdfService } from "../../src/shared/pdfService";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env.PDF_SERVICE_URL = "https://pdf.example.test";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  delete process.env.PDF_SERVICE_URL;
});

describe("renderViaPdfService", () => {
  it("posts JSON body with x-api-key and returns base64 PDF", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(Buffer.from("%PDF-1.4 fake"), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await renderViaPdfService({
      path: "/render/invoice",
      body: { snapshot: { name: "Acme" }, data: { invoiceId: "INV-1" } },
      apiKey: "secret-key",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://pdf.example.test/render/invoice");
    expect((init as RequestInit).method).toBe("POST");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("x-api-key")).toBe("secret-key");
    expect(headers.get("content-type")).toBe("application/json");

    expect(result.contentType).toBe("application/pdf");
    expect(Buffer.from(result.pdfBase64, "base64").toString()).toBe(
      "%PDF-1.4 fake",
    );
  });

  it("strips trailing slashes from PDF_SERVICE_URL", async () => {
    process.env.PDF_SERVICE_URL = "https://pdf.example.test///";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(Buffer.from("ok"), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    await renderViaPdfService({
      path: "/render/quote",
      body: {},
      apiKey: "k",
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://pdf.example.test/render/quote",
    );
  });

  it("throws failed-precondition when PDF_SERVICE_URL is missing", async () => {
    delete process.env.PDF_SERVICE_URL;
    await expect(
      renderViaPdfService({ path: "/render/invoice", body: {}, apiKey: "k" }),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("throws failed-precondition when apiKey is empty", async () => {
    await expect(
      renderViaPdfService({ path: "/render/invoice", body: {}, apiKey: "" }),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("maps fetch failures to 'unavailable'", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(
      renderViaPdfService({ path: "/render/invoice", body: {}, apiKey: "k" }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("maps upstream 401 to 'internal' (proxy auth, not user auth)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('{"error":"Unauthorized"}', { status: 401 }),
    ) as typeof fetch;
    await expect(
      renderViaPdfService({ path: "/render/invoice", body: {}, apiKey: "k" }),
    ).rejects.toMatchObject({ code: "internal" });
  });

  it("maps upstream 500 to 'internal'", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("boom", { status: 500 }),
    ) as typeof fetch;
    await expect(
      renderViaPdfService({ path: "/render/invoice", body: {}, apiKey: "k" }),
    ).rejects.toMatchObject({ code: "internal" });
  });

  it("propagates upstream 400 as 'invalid-argument'", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('{"error":"bad payload"}', { status: 400 }),
    ) as typeof fetch;
    await expect(
      renderViaPdfService({ path: "/render/invoice", body: {}, apiKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });
});
