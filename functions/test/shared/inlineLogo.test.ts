import { afterEach, describe, expect, it, vi } from "vitest";
import { inlineLogoOrThrow, LOGO_MAX_BYTES } from "../../src/shared/invoice";

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(impl: typeof fetch): void {
  globalThis.fetch = impl as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("inlineLogoOrThrow", () => {
  it("returns a base64 data URL on success", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    mockFetch(async () =>
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const out = await inlineLogoOrThrow("https://cdn.example.com/logo.png");
    expect(out.startsWith("data:image/png;base64,")).toBe(true);
    expect(out).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
  });

  it("falls back to image/png when content-type header is missing", async () => {
    mockFetch(async () => new Response(Buffer.from([1, 2, 3]), { status: 200 }));
    const out = await inlineLogoOrThrow("https://cdn.example.com/logo");
    expect(out.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("rejects non-https URLs", async () => {
    await expect(
      inlineLogoOrThrow("http://insecure.example.com/logo.png"),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("rejects javascript: URLs", async () => {
    await expect(
      inlineLogoOrThrow("javascript:alert(1)"),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("rejects data: URLs", async () => {
    await expect(
      inlineLogoOrThrow("data:image/png;base64,AAAA"),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("throws on non-2xx response", async () => {
    mockFetch(async () => new Response("not found", { status: 404 }));
    await expect(
      inlineLogoOrThrow("https://cdn.example.com/missing.png"),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("throws when fetch itself rejects", async () => {
    mockFetch(async () => {
      throw new Error("network down");
    });
    await expect(
      inlineLogoOrThrow("https://cdn.example.com/logo.png"),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("throws when payload exceeds 500KB", async () => {
    const oversized = Buffer.alloc(LOGO_MAX_BYTES + 1, 0);
    mockFetch(async () =>
      new Response(oversized, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    await expect(
      inlineLogoOrThrow("https://cdn.example.com/big.png"),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("accepts payloads exactly at the 500KB boundary", async () => {
    const atCap = Buffer.alloc(LOGO_MAX_BYTES, 0);
    mockFetch(async () =>
      new Response(atCap, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    const out = await inlineLogoOrThrow("https://cdn.example.com/edge.jpg");
    expect(out.startsWith("data:image/jpeg;base64,")).toBe(true);
  });
});
