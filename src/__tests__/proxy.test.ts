import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

const edgeConfigGet = vi.fn<(key: string) => Promise<string | null>>();

vi.mock("@/lib/edgeConfig", () => ({
  edgeConfigGet: (key: string) => edgeConfigGet(key),
  edgeConfigPut: vi.fn(async () => true),
}));

const { proxy, config } = await import("@/proxy");

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
  it.each(["proxy.ts", "instrumentation.ts", "instrumentation-client.ts"])(
    "%s lives in src/, not the repo root",
    (file) => {
      expect(existsSync(path.join(ROOT, "src", file))).toBe(true);
      expect(existsSync(path.join(ROOT, file))).toBe(false);
    },
  );

  it("has no leftover middleware file (Next 16 renamed it to proxy)", () => {
    expect(existsSync(path.join(ROOT, "src", "middleware.ts"))).toBe(false);
    expect(existsSync(path.join(ROOT, "middleware.ts"))).toBe(false);
  });

  it("does not configure a runtime (proxy is always Node.js in Next 16)", () => {
    expect(config).not.toHaveProperty("runtime");
  });
});

describe("proxy host routing", () => {
  it("passes the generic portal host through without a tenant", async () => {
    const res = await proxy(request("portal.techflowsolutions.ca"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(forwardedTenantId(res)).toBeNull();
    expect(edgeConfigGet).not.toHaveBeenCalled();
  });

  it("strips a spoofed x-tenant-id on the generic host", async () => {
    const res = await proxy(
      request("portal.techflowsolutions.ca", { "x-tenant-id": "victim" }),
    );
    expect(forwardedTenantId(res)).toBeNull();
  });

  it.each(["localhost:3000", "127.0.0.1:3000", "techflow-saas-git-main.vercel.app"])(
    "treats %s as generic",
    async (host) => {
      const res = await proxy(request(host, { "x-tenant-id": "victim" }));
      expect(res.status).toBe(200);
      expect(forwardedTenantId(res)).toBeNull();
    },
  );

  it("injects the resolved tenant for a known custom domain", async () => {
    edgeConfigGet.mockResolvedValueOnce("t1");
    const res = await proxy(request("invoices.smithplumbing.ca"));
    expect(forwardedTenantId(res)).toBe("t1");
  });

  it("overwrites a spoofed x-tenant-id on a custom domain", async () => {
    edgeConfigGet.mockResolvedValueOnce("t1");
    const res = await proxy(
      request("invoices.smithplumbing.ca", { "x-tenant-id": "victim" }),
    );
    expect(forwardedTenantId(res)).toBe("t1");
  });

  it("lowercases the host before lookup", async () => {
    edgeConfigGet.mockResolvedValueOnce("t1");
    await proxy(request("Invoices.SmithPlumbing.ca"));
    // A-07: a valid Global Config key (^[\w-]+$), shared with setupCustomDomain.
    expect(edgeConfigGet.mock.calls[0][0]).toBe("domain_invoices_smithplumbing_ca");
  });

  it("returns 404 for an unknown custom domain", async () => {
    const res = await proxy(request("unknown.example.com"));
    expect(res.status).toBe(404);
  });
});

describe("F-04 — `/` goes to each host's home", () => {
  function requestPath(host: string, path: string) {
    return new NextRequest(`https://${host}${path}`, { headers: { host } });
  }

  it("the proxy runs on `/`", () => {
    expect(unstable_doesMiddlewareMatch({ config, url: "/" })).toBe(true);
    expect(unstable_doesMiddlewareMatch({ config, url: "/api/pdf/invoice" })).toBe(false);
  });

  it.each([
    "portal.techflowsolutions.ca",
    "localhost:3000",
    "127.0.0.1:3000",
    "techflow-saas-git-main.vercel.app",
  ])("sends %s to the dashboard, whose guard routes everyone else", async (host) => {
    const req = requestPath(host, "/");
    const res = await proxy(req);
    expect(res.status).toBe(307);
    // Same host as Next sees it (NextURL reads 127.0.0.1 as localhost); Next's
    // adapter then sends a same-host Location as a relative path, so the
    // browser stays on the host it asked for.
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.host).toBe(req.nextUrl.host);
    expect(location.pathname).toBe("/dashboard");
    expect(edgeConfigGet).not.toHaveBeenCalled();
  });

  it("treats the staging host like the portal host", async () => {
    vi.stubEnv("PORTAL_GENERIC_HOST", "staging.techflowsolutions.ca");
    const res = await proxy(requestPath("staging.techflowsolutions.ca", "/"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://staging.techflowsolutions.ca/dashboard");
  });

  it("sends a business's custom domain to its customer portal", async () => {
    edgeConfigGet.mockResolvedValueOnce("t1");
    const res = await proxy(requestPath("invoices.smithplumbing.ca", "/"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://invoices.smithplumbing.ca/portal");
  });

  it("still answers 404 on an unknown host rather than redirecting", async () => {
    const res = await proxy(requestPath("unknown.example.com", "/"));
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("keeps the query string", async () => {
    const res = await proxy(requestPath("portal.techflowsolutions.ca", "/?ref=email"));
    expect(res.headers.get("location")).toBe(
      "https://portal.techflowsolutions.ca/dashboard?ref=email",
    );
  });

  it("passes the home pages themselves through", async () => {
    const dashboard = await proxy(requestPath("portal.techflowsolutions.ca", "/dashboard"));
    expect(dashboard.headers.get("x-middleware-next")).toBe("1");

    edgeConfigGet.mockResolvedValueOnce("t1");
    const portal = await proxy(requestPath("invoices.smithplumbing.ca", "/portal"));
    expect(portal.headers.get("x-middleware-next")).toBe("1");
    expect(forwardedTenantId(portal)).toBe("t1");
  });
});
