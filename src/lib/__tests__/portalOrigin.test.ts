import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { portalOrigin } from "../../../functions/src/shared/portalLinks";
import { portalOriginFor } from "../tenant/portalOrigin";

const SHARED = "https://portal.example.test";
const ORIGINAL_APP_URL = process.env.APP_URL;

beforeEach(() => {
  process.env.APP_URL = SHARED;
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = ORIGINAL_APP_URL;
});

const CASES = [
  { customDomain: "Invoices.Acme.ca", customDomainStatus: { stage: "verified" } },
  { customDomain: "invoices.acme.ca", customDomainStatus: { stage: "ssl_pending" } },
  { customDomain: "invoices.acme.ca", customDomainStatus: null },
  { customDomain: "", customDomainStatus: { stage: "verified" } },
  { customDomain: null, customDomainStatus: { stage: "unverified" } },
  {},
  null,
  undefined,
];

describe("portalOriginFor", () => {
  it("matches the Cloud Functions rule for every kind of business", () => {
    for (const meta of CASES) {
      expect(portalOriginFor(meta, SHARED)).toBe(portalOrigin(meta));
    }
  });

  it("uses a verified custom domain, else the shared host's origin", () => {
    expect(portalOriginFor(CASES[0], SHARED)).toBe("https://invoices.acme.ca");
    expect(portalOriginFor(CASES[1], "https://portal.example.test/")).toBe(SHARED);
  });
});
