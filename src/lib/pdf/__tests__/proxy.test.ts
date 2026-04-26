import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfServiceError, proxyToPdfService } from "../proxy";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env.PDF_SERVICE_URL = "https://pdf.example.test";
  process.env.PDF_SERVICE_API_KEY = "secret-key";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  delete process.env.PDF_SERVICE_URL;
  delete process.env.PDF_SERVICE_API_KEY;
});

describe("proxyToPdfService", () => {
  it("posts JSON body with x-api-key and returns PDF response", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(Buffer.from("%PDF-1.4 fake"), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const res = await proxyToPdfService({
      path: "/render/invoice",
      body: { snapshot: {}, data: { invoiceId: "INV-1" } },
      filename: "INV-1.pdf",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://pdf.example.test/render/invoice");
    expect((init as RequestInit).method).toBe("POST");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("x-api-key")).toBe("secret-key");
    expect(headers.get("content-type")).toBe("application/json");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("INV-1.pdf");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns 500 when PDF_SERVICE_URL is missing", async () => {
    delete process.env.PDF_SERVICE_URL;
    await expect(
      proxyToPdfService({ path: "/render/invoice", body: {}, filename: "x.pdf" }),
    ).rejects.toMatchObject({ status: 500, message: /PDF_SERVICE_URL/ });
  });

  it("returns 500 when PDF_SERVICE_API_KEY is missing", async () => {
    delete process.env.PDF_SERVICE_API_KEY;
    await expect(
      proxyToPdfService({ path: "/render/invoice", body: {}, filename: "x.pdf" }),
    ).rejects.toMatchObject({ status: 500, message: /PDF_SERVICE_API_KEY/ });
  });

  it("maps fetch failures to 502", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(
      proxyToPdfService({ path: "/render/invoice", body: {}, filename: "x.pdf" }),
    ).rejects.toMatchObject({ status: 502, message: /unreachable/ });
  });

  it("maps upstream 401 to 502 (proxy auth, not user auth)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('{"error":"Unauthorized"}', { status: 401 }),
    ) as typeof fetch;
    await expect(
      proxyToPdfService({ path: "/render/invoice", body: {}, filename: "x.pdf" }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("propagates upstream 400 as 400 (caller's bad payload)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('{"error":"bad"}', { status: 400 }),
    ) as typeof fetch;
    await expect(
      proxyToPdfService({ path: "/render/invoice", body: {}, filename: "x.pdf" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("sanitizes hostile filename characters out of Content-Disposition", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(Buffer.from("ok"), { status: 200 }),
    ) as typeof fetch;
    const res = await proxyToPdfService({
      path: "/render/invoice",
      body: {},
      filename: 'x\\.pdf";<script>',
    });
    const cd = res.headers.get("content-disposition") ?? "";
    // Strip the wrapping `inline; filename="..."` quotes and the leading
    // `inline;`, then assert no hostile chars remain in the filename itself.
    const match = /filename="([^"]*)"/.exec(cd);
    expect(match).not.toBeNull();
    const inner = match![1];
    expect(inner).not.toMatch(/[<>"\\;]/);
  });

  it("throws PdfServiceError instances", async () => {
    delete process.env.PDF_SERVICE_URL;
    try {
      await proxyToPdfService({ path: "/render/invoice", body: {}, filename: "x.pdf" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PdfServiceError);
    }
  });
});
