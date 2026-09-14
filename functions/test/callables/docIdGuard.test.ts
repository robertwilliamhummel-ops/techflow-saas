// Caller-supplied document ids become one Firestore path segment. Every tenant
// callable that takes one must refuse anything requireDocId refuses — a "/"
// would address a different document inside the tenant.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("firebase-functions/params", () => ({
  defineSecret: () => ({ value: () => "test-secret-value-at-least-32-chars!!" }),
}));

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  SendEmailCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { clearFirestore, fakeRequest } from "./_setup";
import { deleteInvoiceHandler } from "../../src/invoices/deleteInvoice";
import { markInvoicePaidHandler } from "../../src/invoices/markInvoicePaid";
import { previewInvoicePDFHandler } from "../../src/invoices/previewInvoicePDF";
import { regenerateInvoicePayLinkHandler } from "../../src/invoices/regenerateInvoicePayLink";
import { sendInvoiceEmailHandler } from "../../src/invoices/sendInvoiceEmail";
import { updateInvoiceHandler } from "../../src/invoices/updateInvoice";
import { voidInvoiceHandler } from "../../src/invoices/voidInvoice";
import { convertQuoteToInvoiceHandler } from "../../src/quotes/convertQuoteToInvoice";
import { deleteQuoteHandler } from "../../src/quotes/deleteQuote";
import { previewQuotePDFHandler } from "../../src/quotes/previewQuotePDF";
import { sendQuoteEmailHandler } from "../../src/quotes/sendQuoteEmail";
import { updateQuoteHandler } from "../../src/quotes/updateQuote";

const owner = {
  uid: "u_owner",
  claims: { email: "owner@ids.test", tenantId: "ids-tenant", role: "owner" as const },
};

type Handler = (request: ReturnType<typeof fakeRequest>) => Promise<unknown>;

const CALLABLES: Array<[name: string, handler: Handler, field: "invoiceId" | "quoteId"]> = [
  ["updateInvoice", updateInvoiceHandler as unknown as Handler, "invoiceId"],
  ["deleteInvoice", deleteInvoiceHandler as unknown as Handler, "invoiceId"],
  ["voidInvoice", voidInvoiceHandler as unknown as Handler, "invoiceId"],
  ["markInvoicePaid", markInvoicePaidHandler as unknown as Handler, "invoiceId"],
  ["sendInvoiceEmail", sendInvoiceEmailHandler as unknown as Handler, "invoiceId"],
  ["previewInvoicePDF", previewInvoicePDFHandler as unknown as Handler, "invoiceId"],
  ["regenerateInvoicePayLink", regenerateInvoicePayLinkHandler as unknown as Handler, "invoiceId"],
  ["updateQuote", updateQuoteHandler as unknown as Handler, "quoteId"],
  ["deleteQuote", deleteQuoteHandler as unknown as Handler, "quoteId"],
  ["sendQuoteEmail", sendQuoteEmailHandler as unknown as Handler, "quoteId"],
  ["previewQuotePDF", previewQuotePDFHandler as unknown as Handler, "quoteId"],
  ["convertQuoteToInvoice", convertQuoteToInvoiceHandler as unknown as Handler, "quoteId"],
];

const BAD_IDS = ["INV-0001/paymentIncidents/x", "__reserved__", "INV 0001"];

describe("caller-supplied document ids go through requireDocId", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  for (const [name, handler, field] of CALLABLES) {
    it(`${name} refuses an id that isn't a single document id`, async () => {
      for (const id of BAD_IDS) {
        await expect(handler(fakeRequest({ [field]: id }, owner))).rejects.toThrow(
          new RegExp(`${field} is invalid`),
        );
      }
    });
  }
});
