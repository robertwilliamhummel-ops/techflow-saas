// Global Config is optional: production (Vercel Hobby, one store per account,
// which staging has) runs without a store, and its EDGE_CONFIG_ID secret holds a
// placeholder. Cache writes are then skipped — logged once — never failed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { secrets, loggerInfo } = vi.hoisted(() => ({
  secrets: {} as Record<string, string>,
  loggerInfo: vi.fn(),
}));

vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => secrets[name] ?? "" }),
}));

vi.mock("firebase-functions/logger", () => ({
  info: loggerInfo,
  warn: vi.fn(),
  error: vi.fn(),
}));

const ORIGINAL_FETCH = globalThis.fetch;
const fetchMock = vi.fn();

// A fresh module per test, so its once-per-instance log starts over.
async function loadVercel() {
  vi.resetModules();
  return await import("../../src/shared/vercel");
}

beforeEach(() => {
  for (const key of Object.keys(secrets)) delete secrets[key];
  secrets.VERCEL_API_TOKEN = "tok_test";
  loggerInfo.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("Global Config cache writes without a store", () => {
  it.each([
    ["the no-store placeholder", "unset-hobby-plan-one-store-limit"],
    ["an unset secret", ""],
  ])("skips them for %s, logging once", async (_label, id) => {
    secrets.EDGE_CONFIG_ID = id;
    const vercel = await loadVercel();

    expect(vercel.globalConfigStoreId()).toBeNull();
    await expect(vercel.edgeConfigUpsert("domain_a_test_ca", "acme")).resolves.toBeUndefined();
    await expect(vercel.edgeConfigDelete("domain_a_test_ca")).resolves.toBeUndefined();
    await expect(vercel.edgeConfigUpsert("domain_b_test_ca", "acme")).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledTimes(1);
  });

  it("the placeholder constant is the value production's secret holds", async () => {
    const vercel = await loadVercel();
    expect(vercel.NO_GLOBAL_CONFIG_STORE).toBe("unset-hobby-plan-one-store-limit");
  });
});

describe("Global Config cache writes with a store", () => {
  it("PATCHes the store's items", async () => {
    secrets.EDGE_CONFIG_ID = "ecfg_abc123";
    secrets.VERCEL_TEAM_ID = "team_1";
    const vercel = await loadVercel();

    expect(vercel.globalConfigStoreId()).toBe("ecfg_abc123");
    await vercel.edgeConfigUpsert("domain_a_test_ca", "acme");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.vercel.com/v1/global-config/ecfg_abc123/items?teamId=team_1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      items: [{ operation: "upsert", key: "domain_a_test_ca", value: "acme" }],
    });
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it("still reports a failed write to the caller", async () => {
    secrets.EDGE_CONFIG_ID = "ecfg_abc123";
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Store not found" } }), { status: 404 }),
    );
    const vercel = await loadVercel();
    await expect(vercel.edgeConfigDelete("domain_a_test_ca")).rejects.toThrow("Store not found");
  });
});
