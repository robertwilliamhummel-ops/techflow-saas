// A-07 — custom-domain cache keys must be valid Global Config keys, and the
// Next.js proxy (reads) and Cloud Functions (writes) must agree on them.

import { describe, expect, it } from "vitest";
import { domainCacheKey } from "../../src/shared/domainCacheKey";
import { domainCacheKey as appDomainCacheKey } from "../../../src/lib/domainCacheKey";

// Vercel Global Config key rules: ^[\w-]+$, at most 256 characters.
const VALID_KEY = /^[\w-]+$/;

const LONGEST_VALID_HOST = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(54)}.ca`; // 249 chars → 256-char key
const TOO_LONG_HOST = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.ca`; // 252 chars → 259-char key

const CASES: Array<[host: string, expected: string | null]> = [
  ["invoices.smithplumbing.ca", "domain_invoices_smithplumbing_ca"],
  ["Invoices.SmithPlumbing.CA", "domain_invoices_smithplumbing_ca"],
  [" invoices.smithplumbing.ca ", "domain_invoices_smithplumbing_ca"],
  ["pay.my-shop.co.uk", "domain_pay_my-shop_co_uk"],
  ["xn--bcher-kva.example", "domain_xn--bcher-kva_example"],
  [LONGEST_VALID_HOST, `domain_${LONGEST_VALID_HOST.replace(/\./g, "_")}`],
  [TOO_LONG_HOST, null],
  ["localhost", null],
  ["invoices.smithplumbing.ca:443", null],
  ["under_score.example.com", null],
  ["-leading.example.com", null],
  ["trailing-.example.com", null],
  ["example.com.", null],
  ["", null],
];

describe("domainCacheKey (A-07)", () => {
  for (const [host, expected] of CASES) {
    it(`${JSON.stringify(host.length > 40 ? `${host.slice(0, 20)}…(${host.length} chars)` : host)} → ${expected === null ? "null" : expected.length > 40 ? `${expected.length}-char key` : expected}`, () => {
      expect(domainCacheKey(host)).toBe(expected);
    });
  }

  it("every key it produces is a valid Global Config key", () => {
    for (const [host] of CASES) {
      const key = domainCacheKey(host);
      if (key === null) continue;
      expect(key).toMatch(VALID_KEY);
      expect(key.length).toBeLessThanOrEqual(256);
    }
  });

  it("different hosts never share a key", () => {
    expect(domainCacheKey("a-b.example.com")).not.toBe(
      domainCacheKey("a.b-example.com"),
    );
    expect(domainCacheKey("ab.cd.example")).not.toBe(
      domainCacheKey("a.bcd.example"),
    );
  });

  it("the Next.js proxy copy gives exactly the same answers", () => {
    for (const [host] of CASES) {
      expect(appDomainCacheKey(host)).toBe(domainCacheKey(host));
    }
  });
});
