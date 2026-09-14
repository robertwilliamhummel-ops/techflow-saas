// R-04 — the web app starts App Check only in the browser with a site key,
// and never uses a debug token in a production build.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const initializeAppCheck = vi.fn();
// The provider is constructed with `new`, so the stand-in must be a class
// (vitest 4 refuses arrow-function mocks as constructors).
vi.mock("firebase/app-check", () => ({
  initializeAppCheck: (...args: unknown[]) => initializeAppCheck(...args),
  ReCaptchaEnterpriseProvider: class {
    siteKey: string;
    constructor(siteKey: string) {
      this.siteKey = siteKey;
    }
  },
}));

const { startAppCheck } = await import("@/lib/firebase/client");

type DebugGlobal = { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean };
const app = { name: "[DEFAULT]" } as never;

beforeEach(() => {
  initializeAppCheck.mockReset();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("self", globalThis);
  delete (globalThis as DebugGlobal).FIREBASE_APPCHECK_DEBUG_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete (globalThis as DebugGlobal).FIREBASE_APPCHECK_DEBUG_TOKEN;
});

describe("startAppCheck (R-04)", () => {
  it("starts reCAPTCHA Enterprise App Check with token auto-refresh", () => {
    vi.stubEnv("NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY", "site-key-123");

    expect(startAppCheck(app)).toBe(true);
    expect(initializeAppCheck).toHaveBeenCalledWith(app, {
      provider: { siteKey: "site-key-123" },
      isTokenAutoRefreshEnabled: true,
    });
  });

  it("does nothing without a site key", () => {
    vi.stubEnv("NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY", "");
    expect(startAppCheck(app)).toBe(false);
    expect(initializeAppCheck).not.toHaveBeenCalled();
  });

  it("does nothing on the server", () => {
    vi.stubEnv("NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY", "site-key-123");
    vi.stubGlobal("window", undefined);
    expect(startAppCheck(app)).toBe(false);
    expect(initializeAppCheck).not.toHaveBeenCalled();
  });

  it.each([
    ["ci-token-abc", "ci-token-abc"],
    ["true", true],
  ])("uses the debug token %j outside production", (value, expected) => {
    vi.stubEnv("NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY", "site-key-123");
    vi.stubEnv("NEXT_PUBLIC_APP_CHECK_DEBUG_TOKEN", value);
    vi.stubEnv("NODE_ENV", "development");

    startAppCheck(app);
    expect((globalThis as DebugGlobal).FIREBASE_APPCHECK_DEBUG_TOKEN).toBe(expected);
  });

  it("never uses a debug token in a production build", () => {
    vi.stubEnv("NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY", "site-key-123");
    vi.stubEnv("NEXT_PUBLIC_APP_CHECK_DEBUG_TOKEN", "leaked-token");
    vi.stubEnv("NODE_ENV", "production");

    expect(startAppCheck(app)).toBe(true);
    expect((globalThis as DebugGlobal).FIREBASE_APPCHECK_DEBUG_TOKEN).toBeUndefined();
  });
});
