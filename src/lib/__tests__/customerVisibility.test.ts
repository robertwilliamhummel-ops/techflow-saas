import { describe, expect, it } from "vitest";
import * as server from "../../../functions/src/shared/customerVisibility";
import {
  CUSTOMER_VISIBLE_INVOICE_STATUSES,
  CUSTOMER_VISIBLE_QUOTE_STATUSES,
  isCustomerVisibleInvoiceStatus,
  isCustomerVisibleQuoteStatus,
} from "../portal/customerVisibility";

describe("customer-visible statuses", () => {
  it("mirror the Cloud Functions lists", () => {
    expect([...CUSTOMER_VISIBLE_INVOICE_STATUSES]).toEqual([
      ...server.CUSTOMER_VISIBLE_INVOICE_STATUSES,
    ]);
    expect([...CUSTOMER_VISIBLE_QUOTE_STATUSES]).toEqual([
      ...server.CUSTOMER_VISIBLE_QUOTE_STATUSES,
    ]);
  });

  it("never include drafts, or anything that isn't a status", () => {
    for (const value of ["draft", "", "PAID", undefined, null, 3]) {
      expect(isCustomerVisibleInvoiceStatus(value)).toBe(false);
      expect(isCustomerVisibleQuoteStatus(value)).toBe(false);
    }
    expect(isCustomerVisibleInvoiceStatus("void")).toBe(true);
    expect(isCustomerVisibleQuoteStatus("converted")).toBe(true);
  });
});
