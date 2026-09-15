// S-09 — the amounts the pay page shows are the amounts checkout charges.

import { describe, expect, it } from "vitest";
import { cardChargeFor, cardPaymentsReady } from "../../src/shared/payAmounts";

function invoice(snapshot: Record<string, unknown> = {}) {
  return {
    totals: { total: 113 },
    tenantSnapshot: { chargeCustomerCardFees: true, cardFeePercent: 2.4, ...snapshot },
  };
}

describe("cardChargeFor", () => {
  it("charges the invoice total with no fee while cardSurcharge is off (D3)", () => {
    expect(cardChargeFor(invoice(), false)).toEqual({
      baseCents: 11_300,
      surcharge: { enabled: false, percent: 0 },
      surchargeCents: 0,
      totalCents: 11_300,
    });
  });

  it("adds the snapshot's fee, capped at 2.4%, once the feature is on", () => {
    expect(cardChargeFor(invoice(), true)).toEqual({
      baseCents: 11_300,
      surcharge: { enabled: true, percent: 2.4 },
      surchargeCents: 271,
      totalCents: 11_571,
    });
    expect(cardChargeFor(invoice({ cardFeePercent: 5 }), true).surcharge.percent).toBe(2.4);
    expect(cardChargeFor(invoice({ chargeCustomerCardFees: false }), true).surchargeCents).toBe(0);
  });

  it("treats a missing total as nothing to charge", () => {
    expect(cardChargeFor({}, false).totalCents).toBe(0);
  });
});

describe("cardPaymentsReady", () => {
  it("needs a connected account that Stripe lets take charges", () => {
    expect(cardPaymentsReady({ stripeAccountId: "acct_1", stripeStatus: { chargesEnabled: true } })).toBe(true);
    expect(cardPaymentsReady({ stripeAccountId: "acct_1", stripeStatus: { chargesEnabled: false } })).toBe(false);
    expect(cardPaymentsReady({ stripeAccountId: "acct_1" })).toBe(false);
    expect(cardPaymentsReady({ stripeStatus: { chargesEnabled: true } })).toBe(false);
    expect(cardPaymentsReady(undefined)).toBe(false);
  });
});
