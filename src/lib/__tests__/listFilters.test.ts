import { describe, expect, it } from "vitest";
import { PAYABLE_INVOICE_STATUSES } from "@/lib/invoices/dueStatus";
import {
  INVOICE_LIST_FILTERS,
  invoiceFilterFor,
  invoiceFilterHref,
  matchesInvoiceSearch,
  visibleInvoices,
} from "@/lib/invoices/listFilters";
import type { InvoiceStatus } from "@/lib/schema/tenant";

const TODAY = "2026-09-14";

function row(
  id: string,
  status: InvoiceStatus,
  dueDate: string,
  name = "Maria Chen",
  email = "maria@example.com",
) {
  return { id, status, dueDate, customer: { name, email, phone: null } };
}

describe("invoiceFilterFor", () => {
  it("reads a known filter and falls back to All", () => {
    expect(invoiceFilterFor("overdue").key).toBe("overdue");
    expect(invoiceFilterFor(null).key).toBe("all");
    expect(invoiceFilterFor("nonsense").key).toBe("all");
  });

  it("queries the payable statuses for Outstanding and Overdue", () => {
    expect(invoiceFilterFor("outstanding").statuses).toEqual(PAYABLE_INVOICE_STATUSES);
    expect(invoiceFilterFor("overdue")).toMatchObject({
      statuses: PAYABLE_INVOICE_STATUSES,
      pastDueOnly: true,
    });
  });

  it("gives every filter a query Firestore accepts (at most 30 in values)", () => {
    for (const filter of INVOICE_LIST_FILTERS) {
      if (filter.statuses) {
        expect(filter.statuses.length).toBeGreaterThan(0);
        expect(filter.statuses.length).toBeLessThanOrEqual(30);
      }
    }
  });
});

describe("invoiceFilterHref", () => {
  it("links All to the bare list and others by status", () => {
    expect(invoiceFilterHref("all")).toBe("/invoices");
    expect(invoiceFilterHref("overdue")).toBe("/invoices?status=overdue");
  });
});

describe("matchesInvoiceSearch", () => {
  const invoice = row("INV-0042", "sent", TODAY, "Hélène Tremblay", "helene@example.com");

  it("matches name, email, and invoice number, ignoring case", () => {
    expect(matchesInvoiceSearch(invoice, "TREMBLAY")).toBe(true);
    expect(matchesInvoiceSearch(invoice, "helene@")).toBe(true);
    expect(matchesInvoiceSearch(invoice, "inv-0042")).toBe(true);
    expect(matchesInvoiceSearch(invoice, "0042")).toBe(true);
  });

  it("ignores accents in either direction", () => {
    expect(matchesInvoiceSearch(invoice, "helene tremblay")).toBe(true);
    expect(matchesInvoiceSearch(row("INV-1", "sent", TODAY, "Helene"), "Hélène")).toBe(true);
  });

  it("matches everything for a blank query and nothing unrelated", () => {
    expect(matchesInvoiceSearch(invoice, "   ")).toBe(true);
    expect(matchesInvoiceSearch(invoice, "okafor")).toBe(false);
  });
});

describe("visibleInvoices", () => {
  const rows = [
    row("INV-1", "sent", "2026-09-01", "Maria Chen"),
    row("INV-2", "sent", "2026-10-01", "Daniel Okafor"),
    row("INV-3", "partial", "2026-09-10", "Harbourfront Condo Corp"),
  ];

  it("keeps only past-due invoices for Overdue", () => {
    expect(visibleInvoices(rows, invoiceFilterFor("overdue"), "", TODAY).map((r) => r.id)).toEqual([
      "INV-1",
      "INV-3",
    ]);
  });

  it("applies the search on top of the filter", () => {
    expect(visibleInvoices(rows, invoiceFilterFor("overdue"), "harbour", TODAY).map((r) => r.id)).toEqual([
      "INV-3",
    ]);
    expect(visibleInvoices(rows, invoiceFilterFor("all"), "okafor", TODAY).map((r) => r.id)).toEqual([
      "INV-2",
    ]);
  });
});
