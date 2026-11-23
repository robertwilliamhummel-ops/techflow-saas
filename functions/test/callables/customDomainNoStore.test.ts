// Custom domains without a Global Config store (production on Vercel Hobby):
// the real Vercel helper runs against a mocked Vercel API, and setup, removal
// and re-check all work without ever calling the Global Config endpoints. The
// proxy then finds the domain through customDomains/{domain} in Firestore.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { secrets } = vi.hoisted(() => ({
  secrets: {
    VERCEL_API_TOKEN: "tok_test",
    VERCEL_PROJECT_ID: "prj_test",
    VERCEL_TEAM_ID: "",
    EDGE_CONFIG_ID: "unset-hobby-plan-one-store-limit",
  } as Record<string, string>,
}));

vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => secrets[name] ?? "" }),
}));

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../src/shared/identityToolkit", () => ({
  addAuthorizedDomain: vi.fn().mockResolvedValue(undefined),
  removeAuthorizedDomain: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/shared/recaptchaKey", () => ({
  addRecaptchaAllowedDomain: vi.fn().mockResolvedValue(undefined),
  removeRecaptchaAllowedDomain: vi.fn().mockResolvedValue(undefined),
}));

import * as logger from "firebase-functions/logger";
import { clearFirestore, fakeRequest, testDb } from "./_setup";
import {
  recheckCustomDomainHandler,
  removeCustomDomainHandler,
  setupCustomDomainHandler,
} from "../../src/domain/setupCustomDomain";

const TENANT = "acme";
const ORIGINAL_FETCH = globalThis.fetch;
const vercelCalls: string[] = [];

// Vercel answers OK (verified, configured); everything else — the emulator's
// REST endpoints used by clearFirestore — goes to the real fetch.
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("https://api.vercel.com")) return ORIGINAL_FETCH(input, init);
  vercelCalls.push(`${init?.method ?? "GET"} ${url}`);
  const body = /\/config/.test(url) ? { misconfigured: false } : { verified: true };
  return new Response(JSON.stringify(body), { status: 200 });
});

function adminReq<T extends object>(data: T) {
  return fakeRequest(
    { tenantId: TENANT, ...data },
    { uid: "platform-admin-1", claims: { platformAdmin: true, email_verified: true } },
  );
}

beforeEach(async () => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  vercelCalls.length = 0;
  await clearFirestore();
  await testDb.doc(`tenants/${TENANT}/meta/settings`).set({
    name: "Acme",
    customDomain: null,
    customDomainStatus: { stage: "unverified", message: null, checkedAt: null },
  });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("custom domains with no Global Config store", () => {
  it("setup, re-check and removal work and never call Global Config", async () => {
    await expect(
      setupCustomDomainHandler(adminReq({ domain: "invoices.acme.ca" })),
    ).resolves.toEqual({ ok: true, domain: "invoices.acme.ca" });
    expect((await testDb.doc("customDomains/invoices.acme.ca").get()).data()?.tenantId).toBe(
      TENANT,
    );

    await expect(recheckCustomDomainHandler(adminReq({}))).resolves.toMatchObject({
      stage: "verified",
    });

    await expect(removeCustomDomainHandler(adminReq({}))).resolves.toEqual({ ok: true });
    expect((await testDb.doc("customDomains/invoices.acme.ca").get()).exists).toBe(false);
    expect(
      (await testDb.doc(`tenants/${TENANT}/meta/settings`).get()).data()?.customDomain,
    ).toBeNull();

    expect(vercelCalls.some((c) => c.includes("/global-config"))).toBe(false);
    expect(vercelCalls).toEqual(
      expect.arrayContaining([
        "POST https://api.vercel.com/v10/projects/prj_test/domains",
        "DELETE https://api.vercel.com/v9/projects/prj_test/domains/invoices.acme.ca",
      ]),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("with an unset secret too", async () => {
    secrets.EDGE_CONFIG_ID = "";
    try {
      await expect(
        setupCustomDomainHandler(adminReq({ domain: "pay.acme.ca" })),
      ).resolves.toEqual({ ok: true, domain: "pay.acme.ca" });
      expect(vercelCalls.some((c) => c.includes("/global-config"))).toBe(false);
    } finally {
      secrets.EDGE_CONFIG_ID = "unset-hobby-plan-one-store-limit";
    }
  });
});
