import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CustomerInvoiceView as ServerInvoiceView,
  CustomerQuoteView as ServerQuoteView,
} from "../../../functions/src/portal/customerDocView";
import {
  formatTaxRate,
  isDocId,
  payHref,
  portalInvoiceState,
  portalLoadError,
  portalPdfHref,
  portalQuoteStatus,
  type CustomerInvoiceView,
  type CustomerQuoteView,
} from "../portal/portalDocument";

const TODAY = "2026-09-14";
const NOW = Date.UTC(2026, 8, 14, 16, 0);
const DAY = 86_400_000;

const BUSINESS = {
  name: "Acme Plumbing",
  logoUrl: null,
  address: "12 King St W, Toronto",
  primaryColor: "#0066CC",
  businessNumber: null,
  currency: "CAD",
};

function invoice(overrides: Partial<CustomerInvoiceView> = {}): CustomerInvoiceView {
  return {
    id: "INV-0001",
    tenantId: "acme",
    customer: { name: "Jane Doe", email: "jane@example.com", phone: null },
    lineItems: [{ description: "Service call", quantity: 1, rate: 100, taxable: true, amount: 100 }],
    totals: { subtotal: 100, taxAmount: 13, total: 113, taxes: [{ name: "HST", rate: 0.13, taxableAmount: 100, amount: 13 }] },
    tenantSnapshot: BUSINESS,
    status: "sent",
    issueDate: "2026-09-01",
    notes: null,
    sentAt: null,
    dueDate: "2026-09-30",
    paidAt: null,
    paymentMethod: null,
    paidAmountCents: null,
    surchargeAmountCents: null,
    refundedAt: null,
    refundedAmountCents: null,
    voidedAt: null,
    payToken: "tok.abc-123_x",
    payTokenExpiresAt: NOW + 30 * DAY,
    ...overrides,
  };
}

function quote(overrides: Partial<CustomerQuoteView> = {}): CustomerQuoteView {
  return {
    id: "QT-0001",
    tenantId: "acme",
    customer: { name: "Jane Doe", email: "jane@example.com", phone: null },
    lineItems: [],
    totals: { subtotal: 200, taxAmount: 26, total: 226, taxes: [] },
    tenantSnapshot: BUSINESS,
    status: "sent",
    issueDate: "2026-09-01",
    notes: null,
    sentAt: null,
    validUntil: "2026-10-01",
    ...overrides,
  };
}

describe("customer view types", () => {
  it("match what the detail callables return", () => {
    expectTypeOf<CustomerInvoiceView>().toEqualTypeOf<ServerInvoiceView>();
    expectTypeOf<CustomerQuoteView>().toEqualTypeOf<ServerQuoteView>();
  });
});

describe("isDocId", () => {
  it("accepts a single document id and nothing else", () => {
    expect(isDocId("INV-0001")).toBe(true);
    expect(isDocId("bobs-plumbing")).toBe(true);
    for (const bad of ["", "INV-0001/x", "__reserved__", "INV 1", "x".repeat(129), null, undefined, ["a"]]) {
      expect(isDocId(bad)).toBe(false);
    }
  });
});

describe("portalInvoiceState", () => {
  it("offers Pay while payable, with the link's expiry", () => {
    expect(portalInvoiceState(invoice(), TODAY, NOW)).toEqual({
      status: "sent",
      payable: true,
      balanceCents: 11_300,
      daysOverdue: 0,
      pay: { kind: "pay", href: "/pay/tok.abc-123_x", expiresAt: NOW + 30 * DAY },
    });
  });

  it("shows overdue with days past due", () => {
    expect(
      portalInvoiceState(invoice({ status: "unpaid", dueDate: "2026-09-02" }), TODAY, NOW),
    ).toMatchObject({ status: "overdue", daysOverdue: 12, pay: { kind: "pay" } });
  });

  it("asks only for the balance of a partly paid invoice", () => {
    expect(
      portalInvoiceState(invoice({ status: "partial", paidAmountCents: 5_000 }), TODAY, NOW),
    ).toMatchObject({ status: "partial", payable: true, balanceCents: 6_300 });
  });

  it("says the link expired once its expiry has passed", () => {
    expect(portalInvoiceState(invoice({ payTokenExpiresAt: NOW }), TODAY, NOW)?.pay).toEqual({
      kind: "link-expired",
    });
    expect(portalInvoiceState(invoice({ payTokenExpiresAt: null }), TODAY, NOW)?.pay).toMatchObject({
      kind: "pay",
      expiresAt: null,
    });
  });

  it("keeps a payable invoice payable without a link to pay with", () => {
    expect(portalInvoiceState(invoice({ payToken: null }), TODAY, NOW)).toMatchObject({
      payable: true,
      balanceCents: 11_300,
      pay: null,
    });
  });

  it("offers nothing to pay once nothing is owed", () => {
    for (const status of ["paid", "refunded", "partially-refunded", "void"]) {
      expect(portalInvoiceState(invoice({ status }), TODAY, NOW)).toEqual({
        status,
        payable: false,
        balanceCents: 0,
        daysOverdue: 0,
        pay: null,
      });
    }
  });

  it("has nothing to show for a status customers don't see", () => {
    expect(portalInvoiceState(invoice({ status: "draft" }), TODAY, NOW)).toBeNull();
  });
});

describe("portalQuoteStatus", () => {
  it("derives expired and hides drafts", () => {
    expect(portalQuoteStatus(quote(), TODAY)).toBe("sent");
    expect(portalQuoteStatus(quote({ validUntil: TODAY }), TODAY)).toBe("sent");
    expect(portalQuoteStatus(quote({ validUntil: "2026-09-13" }), TODAY)).toBe("expired");
    expect(portalQuoteStatus(quote({ status: "converted", validUntil: "2026-01-01" }), TODAY)).toBe("converted");
    expect(portalQuoteStatus(quote({ status: "draft" }), TODAY)).toBeNull();
  });
});

describe("links", () => {
  it("builds the pay and PDF links", () => {
    expect(payHref("a.b/c")).toBe("/pay/a.b%2Fc");
    expect(portalPdfHref("invoice", "acme", "INV-0001")).toBe(
      "/api/pdf/invoice?tenantId=acme&invoiceId=INV-0001",
    );
    expect(portalPdfHref("quote", "acme", "QT-0001")).toBe(
      "/api/pdf/quote?tenantId=acme&quoteId=QT-0001",
    );
  });
});

describe("formatTaxRate", () => {
  it("keeps up to three decimals", () => {
    expect(formatTaxRate(0.13)).toBe("13%");
    expect(formatTaxRate(0.05)).toBe("5%");
    expect(formatTaxRate(0.09975)).toBe("9.975%");
  });
});

describe("portalLoadError", () => {
  it("reads missing, someone else's, and malformed as not found", () => {
    for (const code of ["functions/not-found", "functions/permission-denied", "functions/invalid-argument", "not-found"]) {
      expect(portalLoadError({ code })).toBe("not-found");
    }
  });

  it("treats anything else as a failure worth retrying", () => {
    // deadline-exceeded: the call gave up after CUSTOMER_READ_TIMEOUT_MS.
    for (const err of [{ code: "functions/deadline-exceeded" }, { code: "functions/internal" }, { code: "functions/unavailable" }, new Error("offline"), null]) {
      expect(portalLoadError(err)).toBe("failed");
    }
  });
});
