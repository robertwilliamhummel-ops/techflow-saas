import { describe, expect, it } from "vitest";
import {
  EMAIL_STATUS,
  MANUAL_PAYMENT_METHODS,
  paymentMethodLabel,
} from "@/lib/invoices/labels";

describe("paymentMethodLabel", () => {
  it("names every stored method", () => {
    expect(paymentMethodLabel("etransfer")).toBe("e-Transfer");
    expect(paymentMethodLabel("card")).toBe("Card");
    expect(paymentMethodLabel("manual")).toBe("Recorded manually");
  });

  it("is null for missing or unknown methods", () => {
    expect(paymentMethodLabel(null)).toBeNull();
    expect(paymentMethodLabel("cheque")).toBeNull();
  });
});

describe("MANUAL_PAYMENT_METHODS", () => {
  it("is exactly what markInvoicePaid accepts", () => {
    // functions/src/invoices/markInvoicePaid.ts ALLOWED_METHODS
    expect([...MANUAL_PAYMENT_METHODS].sort()).toEqual(["cash", "etransfer", "manual"]);
  });
});

describe("EMAIL_STATUS", () => {
  it("flags failed deliveries as destructive", () => {
    expect(EMAIL_STATUS.bounced.tone).toBe("destructive");
    expect(EMAIL_STATUS.delivered.tone).toBe("success");
  });
});
