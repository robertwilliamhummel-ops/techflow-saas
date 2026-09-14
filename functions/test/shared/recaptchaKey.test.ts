// R-04 — keeping tenant custom domains on the reCAPTCHA Enterprise key that
// App Check uses on the web.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: async () => ({
      getAccessToken: async () => ({ token: "access-token" }),
    }),
  })),
}));

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import {
  RECAPTCHA_MAX_DOMAINS,
  addRecaptchaAllowedDomain,
  removeRecaptchaAllowedDomain,
} from "../../src/shared/recaptchaKey";

const KEY_URL =
  "https://recaptchaenterprise.googleapis.com/v1/projects/test-project/keys/key-123";

const fetchMock = vi.fn();

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function keyWith(webSettings: Record<string, unknown>) {
  return reply(200, { name: "projects/test-project/keys/key-123", webSettings });
}

function patchCall() {
  const call = fetchMock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
  );
  if (!call) return null;
  const [url, init] = call as [string, RequestInit];
  return { url, body: JSON.parse(init.body as string), headers: init.headers };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("RECAPTCHA_KEY_ID", "key-123");
  vi.stubEnv("GCLOUD_PROJECT", "test-project");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("addRecaptchaAllowedDomain (R-04)", () => {
  it("appends the domain with a field-masked PATCH", async () => {
    fetchMock
      .mockResolvedValueOnce(keyWith({ allowedDomains: ["techflowsolutions.ca"] }))
      .mockResolvedValueOnce(reply(200, {}));

    await addRecaptchaAllowedDomain("invoices.acme.test");

    expect(fetchMock.mock.calls[0][0]).toBe(KEY_URL);
    const patch = patchCall()!;
    expect(patch.url).toBe(`${KEY_URL}?updateMask=webSettings.allowedDomains`);
    expect(patch.body).toEqual({
      webSettings: { allowedDomains: ["techflowsolutions.ca", "invoices.acme.test"] },
    });
    expect(patch.headers).toMatchObject({ Authorization: "Bearer access-token" });
  });

  it("does nothing when the domain is already listed", async () => {
    fetchMock.mockResolvedValueOnce(
      keyWith({ allowedDomains: ["techflowsolutions.ca", "invoices.acme.test"] }),
    );
    await addRecaptchaAllowedDomain("invoices.acme.test");
    expect(patchCall()).toBeNull();
  });

  it("does nothing when the key allows all domains", async () => {
    fetchMock.mockResolvedValueOnce(keyWith({ allowAllDomains: true }));
    await addRecaptchaAllowedDomain("invoices.acme.test");
    expect(patchCall()).toBeNull();
  });

  it(`refuses once the key lists ${RECAPTCHA_MAX_DOMAINS} domains`, async () => {
    const full = Array.from({ length: RECAPTCHA_MAX_DOMAINS }, (_, i) => `d${i}.test`);
    fetchMock.mockResolvedValueOnce(keyWith({ allowedDomains: full }));

    await expect(addRecaptchaAllowedDomain("one-more.test")).rejects.toThrow(
      /already allows 250 domains/,
    );
    expect(patchCall()).toBeNull();
  });

  it("passes the API's error message on", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(403, { error: { message: "Permission 'recaptchaenterprise.keys.get' denied" } }),
    );
    await expect(addRecaptchaAllowedDomain("invoices.acme.test")).rejects.toThrow(
      "Permission 'recaptchaenterprise.keys.get' denied",
    );
  });

  it("is skipped while RECAPTCHA_KEY_ID isn't configured", async () => {
    vi.stubEnv("RECAPTCHA_KEY_ID", "");
    await addRecaptchaAllowedDomain("invoices.acme.test");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("removeRecaptchaAllowedDomain (R-04)", () => {
  it("removes the domain and keeps the rest", async () => {
    fetchMock
      .mockResolvedValueOnce(
        keyWith({ allowedDomains: ["techflowsolutions.ca", "invoices.acme.test"] }),
      )
      .mockResolvedValueOnce(reply(200, {}));

    await removeRecaptchaAllowedDomain("invoices.acme.test");

    expect(patchCall()!.body).toEqual({
      webSettings: { allowedDomains: ["techflowsolutions.ca"] },
    });
  });

  it("does nothing when the domain isn't listed", async () => {
    fetchMock.mockResolvedValueOnce(keyWith({ allowedDomains: ["techflowsolutions.ca"] }));
    await removeRecaptchaAllowedDomain("invoices.acme.test");
    expect(patchCall()).toBeNull();
  });

  it("is skipped while RECAPTCHA_KEY_ID isn't configured", async () => {
    vi.stubEnv("RECAPTCHA_KEY_ID", "");
    await removeRecaptchaAllowedDomain("invoices.acme.test");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
