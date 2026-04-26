import { describe, expect, it } from "vitest";
import {
  validateInvoiceBody,
  validateQuoteBody,
  ValidationError,
} from "../src/validate";

const validSnapshot = {
  version: 1,
  name: "Acme",
  logo: null,
  address: "123 Main St",
  primaryColor: "#667eea",
  secondaryColor: "#764ba2",
  fontFamily: "Inter",
  faviconUrl: null,
  taxRate: 0.13,
  taxName: "HST",
  businessNumber: null,
  emailFooter: null,
  currency: "CAD",
  chargeCustomerCardFees: false,
  cardFeePercent: 2.4,
  etransferEmail: null,
};

const validInvoice = {
  invoiceId: "INV-0001",
  issueDate: "2026-04-26",
  dueDate: "2026-05-26",
  status: "sent",
  customer: { name: "Jane", email: "jane@example.com", phone: null },
  lineItems: [{ description: "Work", quantity: 1, rate: 100, amount: 100 }],
  totals: { subtotal: 100, taxRate: 0.13, taxAmount: 13, total: 113 },
  notes: null,
};

describe("validateInvoiceBody", () => {
  it("accepts a well-formed payload", () => {
    expect(() =>
      validateInvoiceBody({ snapshot: validSnapshot, data: validInvoice }),
    ).not.toThrow();
  });

  it("rejects null body", () => {
    expect(() => validateInvoiceBody(null)).toThrow(ValidationError);
  });

  it("rejects empty lineItems", () => {
    expect(() =>
      validateInvoiceBody({
        snapshot: validSnapshot,
        data: { ...validInvoice, lineItems: [] },
      }),
    ).toThrow(/lineItems must not be empty/);
  });

  it("rejects line item with non-numeric quantity", () => {
    expect(() =>
      validateInvoiceBody({
        snapshot: validSnapshot,
        data: {
          ...validInvoice,
          lineItems: [{ description: "x", quantity: "abc", rate: 1, amount: 1 }],
        },
      }),
    ).toThrow(/quantity must be a finite number/);
  });

  it("rejects non-data: logo", () => {
    expect(() =>
      validateInvoiceBody({
        snapshot: { ...validSnapshot, logo: "https://evil.com/logo.png" },
        data: validInvoice,
      }),
    ).toThrow(/data:image/);
  });

  it("rejects oversized logo data URL", () => {
    const huge = "data:image/png;base64," + "A".repeat(900_000);
    expect(() =>
      validateInvoiceBody({
        snapshot: { ...validSnapshot, logo: huge },
        data: validInvoice,
      }),
    ).toThrow(/exceeds max length/);
  });

  it("rejects non-https payUrl", () => {
    expect(() =>
      validateInvoiceBody({
        snapshot: validSnapshot,
        data: { ...validInvoice, payUrl: "javascript:alert(1)" },
      }),
    ).toThrow(/https:\/\//);
  });

  it("rejects unknown paidVia value", () => {
    expect(() =>
      validateInvoiceBody({
        snapshot: validSnapshot,
        data: { ...validInvoice, paidVia: "venmo" },
      }),
    ).toThrow(/paidVia/);
  });

  it("normalizes empty-string optional fields to null", () => {
    const out = validateInvoiceBody({
      snapshot: validSnapshot,
      data: { ...validInvoice, notes: "" },
    });
    expect(out.data.notes).toBeNull();
  });
});

describe("validateQuoteBody", () => {
  it("accepts a well-formed quote", () => {
    expect(() =>
      validateQuoteBody({
        snapshot: validSnapshot,
        data: {
          quoteId: "QT-0001",
          issueDate: "2026-04-26",
          validUntil: "2026-05-26",
          status: "sent",
          customer: validInvoice.customer,
          lineItems: validInvoice.lineItems,
          totals: validInvoice.totals,
          notes: null,
        },
      }),
    ).not.toThrow();
  });

  it("requires quoteId", () => {
    expect(() =>
      validateQuoteBody({
        snapshot: validSnapshot,
        data: {
          issueDate: "2026-04-26",
          validUntil: "2026-05-26",
          status: "sent",
          customer: validInvoice.customer,
          lineItems: validInvoice.lineItems,
          totals: validInvoice.totals,
          notes: null,
        },
      }),
    ).toThrow(/quoteId/);
  });
});
