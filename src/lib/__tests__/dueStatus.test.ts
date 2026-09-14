import { describe, expect, it } from "vitest";
import { PAYABLE_INVOICE_STATUSES as FUNCTIONS_PAYABLE_STATUSES } from "../../../functions/src/shared/invoiceStatus";
import {
  PAYABLE_INVOICE_STATUSES,
  balanceDueCents,
  daysPastDue,
  displayInvoiceStatus,
  isPastDue,
  localIsoDate,
  summarizeReceivables,
  type ReceivableInvoice,
} from "@/lib/invoices/dueStatus";
import type { CurrencyCode, InvoiceStatus } from "@/lib/schema/tenant";

const TODAY = "2026-09-14";

function invoice(
  status: InvoiceStatus,
  dueDate: string,
  total: number,
  extra: { paidAmountCents?: number; currency?: CurrencyCode } = {},
): ReceivableInvoice {
  return {
    status,
    dueDate,
    totals: {
      subtotal: total,
      taxableSubtotal: 0,
      taxRate: 0,
      taxAmount: 0,
      taxes: [],
      total,
    },
    paidAmountCents: extra.paidAmountCents ?? null,
    tenantSnapshot: { currency: extra.currency ?? "CAD" },
  };
}

describe("PAYABLE_INVOICE_STATUSES", () => {
  it("matches the Cloud Functions list", () => {
    expect([...PAYABLE_INVOICE_STATUSES]).toEqual([...FUNCTIONS_PAYABLE_STATUSES]);
  });
});

describe("localIsoDate", () => {
  it("uses the local calendar date, late in the day included", () => {
    expect(localIsoDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localIsoDate(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31");
  });
});

describe("isPastDue", () => {
  it("is true for a payable invoice due before today", () => {
    expect(isPastDue(invoice("sent", "2026-09-13", 10), TODAY)).toBe(true);
    expect(isPastDue(invoice("partial", "2026-08-01", 10), TODAY)).toBe(true);
  });

  it("is false on the due date itself", () => {
    expect(isPastDue(invoice("sent", TODAY, 10), TODAY)).toBe(false);
  });

  it("is false for anything not payable", () => {
    for (const status of ["draft", "paid", "refunded", "partially-refunded", "void"] as const) {
      expect(isPastDue(invoice(status, "2026-01-01", 10), TODAY)).toBe(false);
    }
  });

  it("respects a stored overdue status", () => {
    expect(isPastDue(invoice("overdue", "2026-12-01", 10), TODAY)).toBe(true);
  });
});

describe("displayInvoiceStatus", () => {
  it("shows sent and unpaid invoices past due as overdue", () => {
    expect(displayInvoiceStatus(invoice("sent", "2026-09-01", 10), TODAY)).toBe("overdue");
    expect(displayInvoiceStatus(invoice("unpaid", "2026-09-01", 10), TODAY)).toBe("overdue");
  });

  it("keeps every other status", () => {
    expect(displayInvoiceStatus(invoice("sent", "2026-09-30", 10), TODAY)).toBe("sent");
    expect(displayInvoiceStatus(invoice("partial", "2026-09-01", 10), TODAY)).toBe("partial");
    expect(displayInvoiceStatus(invoice("paid", "2026-09-01", 10), TODAY)).toBe("paid");
    expect(displayInvoiceStatus(invoice("void", "2026-09-01", 10), TODAY)).toBe("void");
  });
});

describe("daysPastDue", () => {
  it("counts whole calendar days", () => {
    expect(daysPastDue("2026-09-01", TODAY)).toBe(13);
    expect(daysPastDue("2026-09-13", TODAY)).toBe(1);
  });

  it("is unaffected by daylight saving changes", () => {
    expect(daysPastDue("2026-03-01", "2026-03-15")).toBe(14);
    expect(daysPastDue("2026-10-25", "2026-11-08")).toBe(14);
  });

  it("is 0 when not yet due", () => {
    expect(daysPastDue("2026-09-30", TODAY)).toBe(0);
  });
});

describe("balanceDueCents", () => {
  it("is the total in cents, without float drift", () => {
    expect(balanceDueCents(invoice("sent", TODAY, 435.05))).toBe(43505);
  });

  it("subtracts what a partial invoice already received", () => {
    expect(balanceDueCents(invoice("partial", TODAY, 100, { paidAmountCents: 2500 }))).toBe(7500);
    expect(balanceDueCents(invoice("partial", TODAY, 100, { paidAmountCents: 20000 }))).toBe(0);
  });
});

describe("summarizeReceivables", () => {
  it("adds outstanding and overdue balances per currency", () => {
    const summaries = summarizeReceivables(
      [
        invoice("sent", "2026-09-01", 100),
        invoice("unpaid", "2026-10-01", 50.5),
        invoice("partial", "2026-09-10", 100, { paidAmountCents: 4000 }),
        invoice("paid", "2026-09-01", 999),
        invoice("draft", "2026-09-01", 999),
        invoice("void", "2026-09-01", 999),
        invoice("sent", "2026-09-01", 20, { currency: "USD" }),
      ],
      TODAY,
      "CAD",
    );
    expect(summaries).toEqual([
      {
        currency: "CAD",
        outstandingCents: 10000 + 5050 + 6000,
        outstandingCount: 3,
        overdueCents: 10000 + 6000,
        overdueCount: 2,
      },
      {
        currency: "USD",
        outstandingCents: 2000,
        outstandingCount: 1,
        overdueCents: 2000,
        overdueCount: 1,
      },
    ]);
  });

  it("puts the preferred currency first and includes it at zero", () => {
    const summaries = summarizeReceivables(
      [invoice("sent", "2026-09-01", 10, { currency: "CAD" })],
      TODAY,
      "USD",
    );
    expect(summaries.map((s) => s.currency)).toEqual(["USD", "CAD"]);
    expect(summaries[0]).toMatchObject({ outstandingCents: 0, outstandingCount: 0 });
  });
});
