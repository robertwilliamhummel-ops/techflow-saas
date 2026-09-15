import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  PayPageInvoice as ServerPayPageInvoice,
  VerifyResult as ServerVerifyResult,
} from "../../../functions/src/portal/verifyInvoicePayToken";
import {
  CHECKOUT_FAILED_MESSAGE,
  checkoutErrorMessage,
  etransferCopyText,
  exceedsTypicalEtransferLimit,
  formatFeePercent,
  isPastDueDate,
  payLoadError,
  type PayPageInvoice,
  type VerifyResult,
} from "../pay/payPage";

function callableError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("pay page types", () => {
  it("match what verifyInvoicePayToken returns", () => {
    expectTypeOf<PayPageInvoice>().toEqualTypeOf<ServerPayPageInvoice>();
    expectTypeOf<VerifyResult>().toEqualTypeOf<ServerVerifyResult>();
  });
});

describe("payLoadError", () => {
  it("reads a refused, missing or malformed link as invalid", () => {
    for (const code of ["functions/permission-denied", "functions/not-found", "functions/invalid-argument"]) {
      expect(payLoadError({ code })).toBe("invalid-link");
    }
  });

  it("treats anything else as worth retrying", () => {
    // deadline-exceeded: the call gave up after CUSTOMER_READ_TIMEOUT_MS.
    for (const err of [{ code: "functions/deadline-exceeded" }, { code: "functions/unavailable" }, { code: "functions/internal" }, new Error("offline"), null]) {
      expect(payLoadError(err)).toBe("failed");
    }
  });
});

describe("checkoutErrorMessage", () => {
  it("passes on the callable's own explanation", () => {
    expect(
      checkoutErrorMessage(callableError("functions/failed-precondition", "Invoice already paid.")),
    ).toBe("Invoice already paid.");
    expect(
      checkoutErrorMessage(
        callableError("functions/permission-denied", "This pay link has been invalidated. Check your email for a newer one."),
      ),
    ).toBe("This pay link has been invalidated. Check your email for a newer one.");
  });

  it("explains the attempt limit, and hides internal failures", () => {
    expect(checkoutErrorMessage(callableError("functions/resource-exhausted", "Too many payment attempts."))).toMatch(
      /too many payment attempts/i,
    );
    expect(checkoutErrorMessage(callableError("functions/internal", "Stripe did not return a checkout URL."))).toBe(
      CHECKOUT_FAILED_MESSAGE,
    );
    expect(checkoutErrorMessage(new Error("network"))).toBe(CHECKOUT_FAILED_MESSAGE);
  });
});

describe("e-Transfer details", () => {
  it("copies the recipient, amount and invoice number", () => {
    expect(etransferCopyText("pay@acme.test", 113_000, "CAD", "INV-0042")).toBe(
      "Send to: pay@acme.test\nAmount: $1,130.00\nMessage: INV-0042",
    );
  });

  it("warns only above the typical $3,000 single-transfer limit", () => {
    expect(exceedsTypicalEtransferLimit(300_000)).toBe(false);
    expect(exceedsTypicalEtransferLimit(300_001)).toBe(true);
  });
});

describe("formatting and dates", () => {
  it("states the card fee percentage", () => {
    expect(formatFeePercent(2.4)).toBe("2.4%");
    expect(formatFeePercent(2)).toBe("2%");
  });

  it("calls an invoice late only after its due date", () => {
    expect(isPastDueDate("sent", "2026-09-13", "2026-09-14")).toBe(true);
    expect(isPastDueDate("sent", "2026-09-14", "2026-09-14")).toBe(false);
    expect(isPastDueDate("overdue", "2026-10-01", "2026-09-14")).toBe(true);
    expect(isPastDueDate("sent", "", "2026-09-14")).toBe(false);
  });
});
