import { describe, expect, it } from "vitest";
import {
  CUSTOMER_VISIBLE_INVOICE_STATUSES,
  CUSTOMER_VISIBLE_QUOTE_STATUSES,
} from "../../../functions/src/shared/customerVisibility";
import type {
  CustomerInvoiceListItem,
  CustomerQuoteListItem,
} from "../portal/CustomerPortalContext";
import {
  PORTAL_FALLBACK_ACCENT,
  PORTAL_INVOICE_STATUSES,
  PORTAL_QUOTE_STATUSES,
  buildPortalHome,
  businessInitial,
  portalAccent,
  portalInvoiceHref,
  portalQuoteHref,
} from "../portal/portalHome";

const TODAY = "2026-09-14";

const BRANDING = { name: "Acme Plumbing", logoUrl: null, primaryColor: "#123456" };

function invoice(
  id: string,
  overrides: Partial<CustomerInvoiceListItem> = {},
): CustomerInvoiceListItem {
  return {
    id,
    path: `tenants/acme/invoices/${id}`,
    tenantId: "acme",
    customer: { name: "Jane Doe", email: "jane@example.com" },
    totals: { subtotal: 100, taxAmount: 13, total: 113 },
    currency: "CAD",
    paidAmountCents: null,
    status: "sent",
    dueDate: "2026-09-30",
    issueDate: "2026-09-01",
    tenantBranding: BRANDING,
    ...overrides,
  };
}

function quote(
  id: string,
  overrides: Partial<CustomerQuoteListItem> = {},
): CustomerQuoteListItem {
  return {
    id,
    path: `tenants/acme/quotes/${id}`,
    tenantId: "acme",
    customer: { name: "Jane Doe", email: "jane@example.com" },
    totals: { subtotal: 200, taxAmount: 26, total: 226 },
    currency: "CAD",
    status: "sent",
    validUntil: "2026-10-01",
    issueDate: "2026-09-01",
    tenantBranding: BRANDING,
    ...overrides,
  };
}

describe("portal statuses", () => {
  it("mirror the statuses the portal callables return", () => {
    expect([...PORTAL_INVOICE_STATUSES]).toEqual([...CUSTOMER_VISIBLE_INVOICE_STATUSES]);
    expect([...PORTAL_QUOTE_STATUSES]).toEqual([...CUSTOMER_VISIBLE_QUOTE_STATUSES]);
  });
});

describe("buildPortalHome — invoices", () => {
  it("puts payable invoices in To pay and settled ones in the history, newest first", () => {
    const home = buildPortalHome(
      [
        invoice("INV-5", { status: "paid" }),
        invoice("INV-4", { status: "sent" }),
        invoice("INV-3", { status: "void" }),
        invoice("INV-2", { status: "refunded" }),
        invoice("INV-1", { status: "partially-refunded" }),
      ],
      [],
      TODAY,
    );

    expect(home.toPay.map((row) => row.invoice.id)).toEqual(["INV-4"]);
    expect(home.pastInvoices.map((row) => [row.invoice.id, row.status, row.balanceCents])).toEqual([
      ["INV-5", "paid", 0],
      ["INV-3", "void", 0],
      ["INV-2", "refunded", 0],
      ["INV-1", "partially-refunded", 0],
    ]);
  });

  it("orders To pay past due first, then by due date, and derives overdue", () => {
    const home = buildPortalHome(
      [
        invoice("A", { dueDate: "2026-09-30" }),
        invoice("B", { status: "unpaid", dueDate: "2026-09-01" }),
        invoice("C", { status: "partial", dueDate: "2026-09-20", paidAmountCents: 5_000 }),
        invoice("D", { dueDate: TODAY }),
        invoice("E", { status: "overdue", dueDate: "2026-10-01" }),
        invoice("F", { status: "partial", dueDate: "2026-09-10", paidAmountCents: 10_000 }),
      ],
      [],
      TODAY,
    );

    expect(
      home.toPay.map((row) => [row.invoice.id, row.status, row.balanceCents, row.daysOverdue]),
    ).toEqual([
      ["B", "overdue", 11_300, 13],
      ["F", "partial", 1_300, 4],
      ["E", "overdue", 11_300, 0],
      ["D", "sent", 11_300, 0],
      ["C", "partial", 6_300, 0],
      ["A", "sent", 11_300, 0],
    ]);
  });

  it("totals what is owed per currency without mixing currencies", () => {
    const home = buildPortalHome(
      [
        invoice("CAD-1", { dueDate: "2026-09-01" }),
        invoice("USD-1", { currency: "USD", totals: { subtotal: 50, taxAmount: 0, total: 50 } }),
        invoice("CAD-2", { status: "partial", paidAmountCents: 3_000 }),
        invoice("CAD-3", { status: "paid" }),
      ],
      [],
      TODAY,
    );

    expect(home.balances).toEqual([
      { currency: "CAD", owedCents: 11_300 + 8_300, count: 2, overdueCents: 11_300, overdueCount: 1 },
      { currency: "USD", owedCents: 5_000, count: 1, overdueCents: 0, overdueCount: 0 },
    ]);
  });

  it("has no balances when nothing is owed", () => {
    expect(buildPortalHome([invoice("INV-1", { status: "paid" })], [], TODAY).balances).toEqual([]);
  });

  it("leaves out a status the portal doesn't show", () => {
    const home = buildPortalHome([invoice("INV-1", { status: "draft" })], [], TODAY);
    expect(home.toPay).toEqual([]);
    expect(home.pastInvoices).toEqual([]);
  });
});

describe("buildPortalHome — quotes", () => {
  it("keeps open quotes soonest to expire first and moves the rest to the history", () => {
    const home = buildPortalHome(
      [],
      [
        quote("QT-5", { validUntil: "2026-10-31" }),
        quote("QT-4", { validUntil: "2026-09-01" }),
        quote("QT-3", { status: "converted" }),
        quote("QT-2", { validUntil: TODAY }),
        quote("QT-1", { status: "declined" }),
        quote("QT-0", { status: "draft" }),
      ],
      TODAY,
    );

    expect(home.openQuotes.map((row) => [row.quote.id, row.status])).toEqual([
      ["QT-2", "sent"],
      ["QT-5", "sent"],
    ]);
    expect(home.pastQuotes.map((row) => [row.quote.id, row.status])).toEqual([
      ["QT-4", "expired"],
      ["QT-3", "converted"],
      ["QT-1", "declined"],
    ]);
  });
});

describe("portal links and branding", () => {
  it("links to the document page with its business", () => {
    expect(portalInvoiceHref({ id: "INV-0001", tenantId: "acme-plumbing" })).toBe(
      "/portal/invoices/INV-0001?tenantId=acme-plumbing",
    );
    expect(portalQuoteHref({ id: "QT 1", tenantId: "a&b" })).toBe(
      "/portal/quotes/QT%201?tenantId=a%26b",
    );
  });

  it("uses a brand colour only when it is a #rrggbb hex", () => {
    expect(portalAccent("#1A2b3C")).toBe("#1A2b3C");
    for (const bad of ["red", "#fff", "url(x)", "", null, undefined]) {
      expect(portalAccent(bad)).toBe(PORTAL_FALLBACK_ACCENT);
    }
  });

  it("shows the business's first letter in place of a logo", () => {
    expect(businessInitial("  acme plumbing")).toBe("A");
    expect(businessInitial("")).toBe("?");
  });
});
