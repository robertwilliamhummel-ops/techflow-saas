// A-07 — the proxy's cache self-heal: a miss resolved from Firestore writes the
// Global Config entry, at most once per host per 10 minutes per instance
// (writes are billed and capped at 100 an hour on Pro).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const edgeConfigGet = vi.fn<(key: string) => Promise<string | null>>();
const edgeConfigPut = vi.fn<(key: string, value: string) => Promise<boolean>>();
vi.mock("@/lib/edgeConfig", () => ({
  edgeConfigGet: (key: string) => edgeConfigGet(key),
  edgeConfigPut: (key: string, value: string) => edgeConfigPut(key, value),
}));

const docGet = vi.fn();
vi.mock("firebase-admin/app", () => ({
  getApps: () => [{}],
  initializeApp: vi.fn(),
  cert: vi.fn(),
}));
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({ doc: () => ({ get: docGet }) }),
}));

// Admin credentials present → the Firestore fallback is enabled.
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = "proxy-test";
process.env.FIREBASE_ADMIN_CLIENT_EMAIL = "proxy@test.iam.gserviceaccount.com";
process.env.FIREBASE_ADMIN_PRIVATE_KEY = "test-key";
process.env.PORTAL_GENERIC_HOST = "portal.techflowsolutions.ca";

const { proxy } = await import("@/proxy");

function request(host: string) {
  return new NextRequest(`https://${host}/portal/login`, { headers: { host } });
}

function forwardedTenantId(res: Response): string | null {
  return res.headers.get("x-middleware-request-x-tenant-id");
}

beforeEach(() => {
  edgeConfigGet.mockReset();
  edgeConfigGet.mockResolvedValue(null);
  edgeConfigPut.mockReset();
  edgeConfigPut.mockResolvedValue(true);
  docGet.mockReset();
  docGet.mockResolvedValue({ exists: true, data: () => ({ tenantId: "t1" }) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("proxy cache self-heal (A-07)", () => {
  it("a cache miss resolves from Firestore and writes the cache entry once", async () => {
    const first = await proxy(request("heal-once.example.com"));
    const second = await proxy(request("heal-once.example.com"));

    expect(forwardedTenantId(first)).toBe("t1");
    expect(forwardedTenantId(second)).toBe("t1");
    expect(docGet).toHaveBeenCalledTimes(2);
    expect(edgeConfigPut).toHaveBeenCalledTimes(1);
    expect(edgeConfigPut).toHaveBeenCalledWith("domain_heal-once_example_com", "t1");
  });

  it("heals the same host again once the 10-minute window has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-13T12:00:00Z"));
    await proxy(request("heal-later.example.com"));

    vi.setSystemTime(new Date("2026-09-13T12:05:00Z"));
    await proxy(request("heal-later.example.com"));
    expect(edgeConfigPut).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-09-13T12:11:00Z"));
    await proxy(request("heal-later.example.com"));
    expect(edgeConfigPut).toHaveBeenCalledTimes(2);
  });

  it("never writes the cache for an unknown domain", async () => {
    docGet.mockResolvedValue({ exists: false, data: () => undefined });

    const res = await proxy(request("unknown.example.com"));

    expect(res.status).toBe(404);
    expect(edgeConfigPut).not.toHaveBeenCalled();
  });

  it("serves a host that can't be a cache key from Firestore without touching the cache", async () => {
    const res = await proxy(request("under_score.example.com"));

    expect(forwardedTenantId(res)).toBe("t1");
    expect(edgeConfigGet).not.toHaveBeenCalled();
    expect(edgeConfigPut).not.toHaveBeenCalled();
  });
});
