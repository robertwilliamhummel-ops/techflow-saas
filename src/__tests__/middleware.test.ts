import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const edgeConfigGet = vi.fn<(key: string) => Promise<string | null>>();

vi.mock("@/lib/edgeConfig", () => ({
  edgeConfigGet: (key: string) => edgeConfigGet(key),
  edgeConfigPut: vi.fn(async () => true),
}));

const { middleware, config } = await import("@/middleware");

const ROOT = process.cwd();

function request(host: string, headers: Record<string, string> = {}) {
  return new NextRequest(`https://${host}/portal/login`, {
    headers: { host, ...headers },
  });
}

// NextResponse.next({ request: { headers } }) lists the forwarded request
// headers in `x-middleware-override-headers` and each value in
// `x-middleware-request-<name>`; anything not listed is dropped.
function forwardedTenantId(res: Response): string | null {
  const names = (res.headers.get("x-middleware-override-headers") ?? "").split(",");
  expect(names.length).toBeGreaterThan(0);
  return names.includes("x-tenant-id")
    ? res.headers.get("x-middleware-request-x-tenant-id")
    : null;
}

beforeEach(() => {
  edgeConfigGet.mockReset();
  edgeConfigGet.mockResolvedValue(null);
  vi.stubEnv("PORTAL_GENERIC_HOST", "portal.techflowsolutions.ca");
  // No Admin credentials → the Firestore fallback is disabled.
  vi.stubEnv("FIREBASE_ADMIN_CLIENT_EMAIL", "");
  vi.stubEnv("FIREBASE_ADMIN_PRIVATE_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("A-01 — Next.js loads these files only from src/", () => {
  it.each(["middleware.ts", "instrumentation.ts", "instrumentation-client.ts"])(
    "%s lives in src/, not the repo root",
    (file) => {
      expect(existsSync(path.join(ROOT, "src", file))).toBe(true);
      expect(existsSync(path.join(ROOT, file))).toBe(false);
    },
  );

  it("runs on the Node.js runtime (Firebase Admin fallback)", () => {
    expect(config.runtime).toBe("nodejs");
  });
});

describe("middleware host routing", () => {
  it("passes the generic portal host through without a tenant", async () => {
    const res = await middleware(request("portal.techflowsolutions.ca"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(forwardedTenantId(res)).toBeNull();
    expect(edgeConfigGet).not.toHaveBeenCalled();
  });

  it("strips a spoofed x-tenant-id on the generic host", async () => {
    const res = await middleware(
      request("portal.techflowsolutions.ca", { "x-tenant-id": "victim" }),
    );
    expect(forwardedTenantId(res)).toBeNull();
  });

  it.each(["localhost:3000", "127.0.0.1:3000", "techflow-saas-git-main.vercel.app"])(
    "treats %s as generic",
    async (host) => {
      const res = await middleware(request(host, { "x-tenant-id": "victim" }));
      expect(res.status).toBe(200);
      expect(forwardedTenantId(res)).toBeNull();
    },
  );

  it("injects the resolved tenant for a known custom domain", async () => {
    edgeConfigGet.mockResolvedValueOnce("t1");
    const res = await middleware(request("invoices.smithplumbing.ca"));
    expect(forwardedTenantId(res)).toBe("t1");
  });

  it("overwrites a spoofed x-tenant-id on a custom domain", async () => {
    edgeConfigGet.mockResolvedValueOnce("t1");
    const res = await middleware(
      request("invoices.smithplumbing.ca", { "x-tenant-id": "victim" }),
    );
    expect(forwardedTenantId(res)).toBe("t1");
  });

  it("lowercases the host before lookup", async () => {
    edgeConfigGet.mockResolvedValueOnce("t1");
    await middleware(request("Invoices.SmithPlumbing.ca"));
    expect(edgeConfigGet.mock.calls[0][0]).toContain("invoices.smithplumbing.ca");
  });

  it("returns 404 for an unknown custom domain", async () => {
    const res = await middleware(request("unknown.example.com"));
    expect(res.status).toBe(404);
  });
});
