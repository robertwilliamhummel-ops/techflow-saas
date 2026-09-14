import { describe, expect, it } from "vitest";
import { VOIDABLE_INVOICE_STATUSES as FUNCTIONS_VOIDABLE } from "../../../functions/src/shared/invoiceStatus";
import {
  VOIDABLE_INVOICE_STATUSES,
  invoiceActionsFor,
  payLinkFor,
} from "@/lib/invoices/invoiceActions";

describe("VOIDABLE_INVOICE_STATUSES", () => {
  it("matches the Cloud Functions list", () => {
    expect([...VOIDABLE_INVOICE_STATUSES]).toEqual([...FUNCTIONS_VOIDABLE]);
  });
});

describe("invoiceActionsFor", () => {
  it("offers an owner everything a draft allows", () => {
    expect(invoiceActionsFor("draft", "owner")).toEqual({
      send: true,
      resend: false,
      previewPdf: true,
      copyPayLink: false,
      reissuePayLink: true,
      markPaid: false,
      void: false,
      deleteDraft: true,
    });
  });

  it("offers an admin payment and void actions on a sent invoice", () => {
    expect(invoiceActionsFor("sent", "admin")).toMatchObject({
      send: false,
      resend: true,
      copyPayLink: true,
      markPaid: true,
      void: true,
      deleteDraft: false,
    });
  });

  it("keeps owner/admin actions from staff", () => {
    for (const status of ["draft", "sent", "overdue", "partial"] as const) {
      expect(invoiceActionsFor(status, "staff")).toMatchObject({
        reissuePayLink: false,
        markPaid: false,
        void: false,
        deleteDraft: false,
      });
    }
    expect(invoiceActionsFor("sent", undefined).markPaid).toBe(false);
  });

  it("lets anyone send a draft and resend while there's something to pay", () => {
    expect(invoiceActionsFor("draft", "staff").send).toBe(true);
    expect(invoiceActionsFor("overdue", "staff").resend).toBe(true);
  });

  it("offers a partial invoice payment but not void (money was recorded)", () => {
    expect(invoiceActionsFor("partial", "owner")).toMatchObject({ markPaid: true, void: false });
  });

  it("offers only the PDF once nothing is owed", () => {
    for (const status of ["paid", "refunded", "partially-refunded", "void"] as const) {
      expect(invoiceActionsFor(status, "owner")).toEqual({
        send: false,
        resend: false,
        previewPdf: true,
        copyPayLink: false,
        reissuePayLink: false,
        markPaid: false,
        void: false,
        deleteDraft: false,
      });
    }
  });
});

describe("payLinkFor", () => {
  it("joins the app URL and token without a double slash", () => {
    expect(payLinkFor("tok", "https://portal.techflowsolutions.ca/")).toBe(
      "https://portal.techflowsolutions.ca/pay/tok",
    );
  });
});
