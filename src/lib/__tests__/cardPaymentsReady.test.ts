import { describe, expect, it } from "vitest";
import { cardPaymentsReady as serverCardPaymentsReady } from "../../../functions/src/shared/payAmounts";
import { cardPaymentsReady } from "../stripe/cardPaymentsReady";

// F-08: the app's PDF route and the Cloud Functions PDF builder decide the
// card section with the same rule.
describe("cardPaymentsReady", () => {
  const cases: Array<[string, Record<string, unknown> | undefined]> = [
    ["no meta", undefined],
    ["no Stripe account", { stripeStatus: { chargesEnabled: true } }],
    ["an empty account id", { stripeAccountId: "", stripeStatus: { chargesEnabled: true } }],
    ["charges not enabled", { stripeAccountId: "acct_1", stripeStatus: { chargesEnabled: false } }],
    ["no Stripe status", { stripeAccountId: "acct_1", stripeStatus: null }],
    ["a truthy non-boolean", { stripeAccountId: "acct_1", stripeStatus: { chargesEnabled: "yes" } }],
    ["ready", { stripeAccountId: "acct_1", stripeStatus: { chargesEnabled: true } }],
  ];

  it.each(cases)("matches the Cloud Functions copy: %s", (_label, meta) => {
    expect(cardPaymentsReady(meta)).toBe(serverCardPaymentsReady(meta));
  });

  it("is true only for a connected account that can take charges", () => {
    expect(cases.filter(([, meta]) => cardPaymentsReady(meta)).map(([label]) => label)).toEqual([
      "ready",
    ]);
  });
});
