// When an invoice email needs a new pay link (audit 2026-11-13): the stored
// token is the 60-day JWT, and its exp claim is the authoritative expiry (P3).

import { describe, expect, it } from "vitest";
import { sign } from "jsonwebtoken";
import {
  PAY_LINK_MIN_REMAINING_MS,
  PAY_LINK_TTL_MS,
  payLinkNeedsReissue,
  payTokenExpiryMs,
  signPayToken,
} from "../../src/shared/payToken";

const SECRET = "test-secret";
const DAY = 24 * 60 * 60 * 1000;
// 2026-11-14T15:00:00Z
const NOW = Date.UTC(2026, 10, 14, 15);

function tokenExpiringIn(ms: number): string {
  return sign(
    { invoiceId: "INV-0001", tenantId: "acme", v: 1, exp: Math.floor((NOW + ms) / 1000) },
    SECRET,
  );
}

describe("payTokenExpiryMs", () => {
  it("reads the JWT's exp claim", () => {
    const token = tokenExpiringIn(10 * DAY);
    expect(payTokenExpiryMs(token)).toBe(Math.floor((NOW + 10 * DAY) / 1000) * 1000);
  });

  it("signPayToken issues links that live 60 days", () => {
    const before = Date.now();
    const token = signPayToken({ invoiceId: "INV-0001", tenantId: "acme", v: 1 }, SECRET);
    const expires = payTokenExpiryMs(token)!;
    expect(expires - before).toBeGreaterThan(PAY_LINK_TTL_MS - 2000);
    expect(expires - before).toBeLessThanOrEqual(PAY_LINK_TTL_MS + 1000);
  });

  it.each([
    ["no token", undefined],
    ["an empty token", ""],
    ["not a JWT", "not-a-jwt"],
    ["a JWT without exp", sign({ invoiceId: "INV-0001" }, SECRET)],
  ])("is null for %s", (_label, token) => {
    expect(payTokenExpiryMs(token)).toBeNull();
  });
});

describe("payLinkNeedsReissue", () => {
  const dueIn = (days: number) =>
    new Date(NOW + days * DAY).toISOString().slice(0, 10);

  it("keeps a link with at least 30 days left that outlasts the due date", () => {
    expect(PAY_LINK_MIN_REMAINING_MS).toBe(30 * DAY);
    expect(payLinkNeedsReissue(tokenExpiringIn(60 * DAY), dueIn(30), NOW)).toBe(false);
    expect(payLinkNeedsReissue(tokenExpiringIn(31 * DAY), dueIn(-10), NOW)).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["unreadable", "garbage"],
    ["expired", tokenExpiringIn(-1 * DAY)],
    ["expiring in 10 days", tokenExpiringIn(10 * DAY)],
    ["expiring in just under 30 days", tokenExpiringIn(30 * DAY - 60_000)],
  ])("re-issues a link that is %s", (_label, token) => {
    expect(payLinkNeedsReissue(token, dueIn(-30), NOW)).toBe(true);
  });

  it("re-issues a link that dies before the due date when a new one would outlast it", () => {
    // 35 days left, due in 40: a new 60-day link covers the due date.
    expect(payLinkNeedsReissue(tokenExpiringIn(35 * DAY), dueIn(40), NOW)).toBe(true);
  });

  it("counts the whole due date, in every Canadian time zone", () => {
    // Expires at 23:00 UTC on the due date — still the afternoon in Toronto.
    const due = dueIn(40);
    const expiresAt = Date.UTC(
      Number(due.slice(0, 4)),
      Number(due.slice(5, 7)) - 1,
      Number(due.slice(8, 10)),
      23,
    );
    expect(payLinkNeedsReissue(tokenExpiringIn(expiresAt - NOW), due, NOW)).toBe(true);
    // Expires the next day at 13:00 UTC: past midnight on Canada's west coast.
    expect(
      payLinkNeedsReissue(tokenExpiringIn(expiresAt - NOW + 14 * 60 * 60 * 1000), due, NOW),
    ).toBe(false);
  });

  it("keeps the link when the due date is further out than any new link would last", () => {
    // Net 90: re-issuing on every send would only churn the link.
    expect(payLinkNeedsReissue(tokenExpiringIn(59 * DAY), dueIn(90), NOW)).toBe(false);
  });

  it("ignores a due date that isn't a calendar date", () => {
    expect(payLinkNeedsReissue(tokenExpiringIn(40 * DAY), "2026-02-31", NOW)).toBe(false);
    expect(payLinkNeedsReissue(tokenExpiringIn(40 * DAY), null, NOW)).toBe(false);
  });
});
