// R-04 — one switch, ENFORCE_APP_CHECK, decides whether callables reject
// requests without an App Check token. Exercised through the real
// firebase-functions callable wrapper over HTTP, because enforcement happens
// there, not in the handlers the other tests call directly.

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function callWithoutAppCheckToken(
  enforce: string | undefined,
): Promise<{ status: number; enforced: boolean }> {
  vi.resetModules();
  vi.stubEnv("ENFORCE_APP_CHECK", enforce ?? "");

  const { ENFORCE_APP_CHECK } = await import("../../src/shared/globalOptions");
  const { onCall } = await import("firebase-functions/v2/https");
  const express = (await import("express")).default;

  const callable = onCall(() => ({ ok: true }));
  const app = express();
  app.use(express.json());
  app.post("/", (req, res) => {
    void callable(req as never, res);
  });

  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: {} }),
    });
    return { status: res.status, enforced: ENFORCE_APP_CHECK };
  } finally {
    server.close();
  }
}

describe("App Check enforcement switch (R-04)", () => {
  it("lets calls without an App Check token through by default", async () => {
    await expect(callWithoutAppCheckToken(undefined)).resolves.toEqual({
      status: 200,
      enforced: false,
    });
  });

  it("rejects calls without an App Check token when ENFORCE_APP_CHECK=true", async () => {
    await expect(callWithoutAppCheckToken("true")).resolves.toEqual({
      status: 401,
      enforced: true,
    });
  });

  it.each(["false", "1", "TRUE", "yes"])(
    "treats ENFORCE_APP_CHECK=%s as off (only the exact value true enforces)",
    async (value) => {
      await expect(callWithoutAppCheckToken(value)).resolves.toEqual({
        status: 200,
        enforced: false,
      });
    },
  );
});
