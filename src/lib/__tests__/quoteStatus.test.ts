import { describe, expect, it } from "vitest";
import {
  displayQuoteStatus,
  matchesQuoteSearch,
  quoteActionsFor,
  quoteFilterFor,
  quoteFilterHref,
  quoteHref,
} from "@/lib/quotes/quoteStatus";

const TODAY = "2026-09-14";

describe("displayQuoteStatus", () => {
  it("shows a sent quote past its valid-until date as expired", () => {
    expect(displayQuoteStatus({ status: "sent", validUntil: "2026-09-13" }, TODAY)).toBe("expired");
  });

  it("keeps a quote open on its last valid day", () => {
    expect(displayQuoteStatus({ status: "sent", validUntil: TODAY }, TODAY)).toBe("sent");
  });

  it("never relabels drafts or converted quotes", () => {
    expect(displayQuoteStatus({ status: "draft", validUntil: "2026-01-01" }, TODAY)).toBe("draft");
    expect(displayQuoteStatus({ status: "converted", validUntil: "2026-01-01" }, TODAY)).toBe("converted");
  });
});

describe("quoteActionsFor", () => {
  it("lets anyone send, preview, and convert a draft; only owners and admins delete", () => {
    expect(quoteActionsFor("draft", "staff", true)).toEqual({
      send: true,
      resend: false,
      previewPdf: true,
      convert: true,
      deleteQuote: false,
    });
    expect(quoteActionsFor("draft", "owner", true).deleteQuote).toBe(true);
  });

  it("offers resend on a sent quote", () => {
    expect(quoteActionsFor("sent", "admin", true)).toMatchObject({ send: false, resend: true, convert: true });
  });

  it("offers only the PDF on a converted quote", () => {
    expect(quoteActionsFor("converted", "owner", true)).toEqual({
      send: false,
      resend: false,
      previewPdf: true,
      convert: false,
      deleteQuote: false,
    });
  });

  it("can't convert without invoicing", () => {
    expect(quoteActionsFor("sent", "owner", false).convert).toBe(false);
  });
});

describe("quote list filters", () => {
  it("reads a known filter and falls back to All", () => {
    expect(quoteFilterFor("converted").statuses).toEqual(["converted"]);
    expect(quoteFilterFor("nonsense").key).toBe("all");
    expect(quoteFilterHref("all")).toBe("/quotes");
    expect(quoteFilterHref("draft")).toBe("/quotes?status=draft");
  });
});

describe("matchesQuoteSearch", () => {
  it("matches the quote number and customer, ignoring accents", () => {
    const quote = { id: "QT-0007", customer: { name: "Hélène Tremblay", email: "helene@example.com", phone: null } };
    expect(matchesQuoteSearch(quote, "qt-0007")).toBe(true);
    expect(matchesQuoteSearch(quote, "helene tremblay")).toBe(true);
    expect(matchesQuoteSearch(quote, "okafor")).toBe(false);
  });
});

describe("quoteHref", () => {
  it("links to the quote detail page", () => {
    expect(quoteHref("ACME-QT-0001")).toBe("/quotes/ACME-QT-0001");
  });
});
