// Global Config wrapper (A-07): SDK reads with GLOBAL_CONFIG → EDGE_CONFIG
// fallback, REST writes on the /v1/global-config path.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const sdkGet = vi.fn();
const createClient = vi.fn((connectionString: string) => {
  void connectionString;
  return { get: sdkGet, getAll: vi.fn() };
});
vi.mock("@vercel/global-config", () => ({
  createClient: (connectionString: string) => createClient(connectionString),
}));

const { edgeConfigGet, edgeConfigPut } = await import("@/lib/edgeConfig");

const realFetch = globalThis.fetch;

beforeEach(() => {
  sdkGet.mockReset();
  createClient.mockClear();
  vi.stubEnv("GLOBAL_CONFIG", "");
  vi.stubEnv("EDGE_CONFIG", "");
  vi.stubEnv("EDGE_CONFIG_ID", "");
  vi.stubEnv("VERCEL_API_TOKEN", "");
  vi.stubEnv("VERCEL_TEAM_ID", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = realFetch;
});

describe("edgeConfigGet", () => {
  it("returns null without a connection string", async () => {
    expect(await edgeConfigGet("domain_example_com")).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("reads through the SDK with GLOBAL_CONFIG, the variable new store connections create", async () => {
    vi.stubEnv("GLOBAL_CONFIG", "https://global-config.vercel.com/ecfg_new?token=read");
    vi.stubEnv("EDGE_CONFIG", "https://edge-config.vercel.com/ecfg_old?token=read");
    sdkGet.mockResolvedValue("tenant_1");

    expect(await edgeConfigGet("domain_example_com")).toBe("tenant_1");
    expect(createClient).toHaveBeenCalledWith(
      "https://global-config.vercel.com/ecfg_new?token=read",
    );
    expect(sdkGet).toHaveBeenCalledWith("domain_example_com");
  });

  it("falls back to the legacy EDGE_CONFIG variable", async () => {
    vi.stubEnv("EDGE_CONFIG", "https://edge-config.vercel.com/ecfg_old?token=read");
    sdkGet.mockResolvedValue("tenant_2");

    expect(await edgeConfigGet("domain_example_com")).toBe("tenant_2");
    expect(createClient).toHaveBeenCalledWith(
      "https://edge-config.vercel.com/ecfg_old?token=read",
    );
  });

  it("returns null for missing keys, non-string values, and SDK errors", async () => {
    vi.stubEnv("GLOBAL_CONFIG", "https://global-config.vercel.com/ecfg_x?token=read");

    sdkGet.mockResolvedValueOnce(undefined);
    expect(await edgeConfigGet("domain_missing")).toBeNull();

    sdkGet.mockResolvedValueOnce({ tenantId: "t" });
    expect(await edgeConfigGet("domain_object")).toBeNull();

    sdkGet.mockRejectedValueOnce(new Error("network"));
    expect(await edgeConfigGet("domain_error")).toBeNull();
  });
});

describe("edgeConfigPut", () => {
  it("skips the write without credentials", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    expect(await edgeConfigPut("domain_example_com", "tenant_1")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("upserts through the Global Config REST API", async () => {
    vi.stubEnv("EDGE_CONFIG_ID", "ecfg_123");
    vi.stubEnv("VERCEL_API_TOKEN", "vercel_token");
    vi.stubEnv("VERCEL_TEAM_ID", "team_abc");
    const fetchSpy = vi.fn(async () => new Response('{"status":"ok"}', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    expect(await edgeConfigPut("domain_example_com", "tenant_1")).toBe(true);

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.vercel.com/v1/global-config/ecfg_123/items?teamId=team_abc",
    );
    expect(init.method).toBe("PATCH");
    expect(init.headers).toMatchObject({ Authorization: "Bearer vercel_token" });
    expect(JSON.parse(String(init.body))).toEqual({
      items: [{ operation: "upsert", key: "domain_example_com", value: "tenant_1" }],
    });
  });

  it("reports a failed write instead of throwing", async () => {
    vi.stubEnv("EDGE_CONFIG_ID", "ecfg_123");
    vi.stubEnv("VERCEL_API_TOKEN", "vercel_token");
    globalThis.fetch = (async () =>
      new Response('{"error":{"code":"forbidden"}}', { status: 403 })) as typeof fetch;

    expect(await edgeConfigPut("domain_example_com", "tenant_1")).toBe(false);
  });
});
