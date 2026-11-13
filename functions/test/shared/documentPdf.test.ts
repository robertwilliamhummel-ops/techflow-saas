// D14: helpers the document emails use to attach their PDF.

import { describe, expect, it, vi } from "vitest";

vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => `test-${name}` }),
}));

import { HttpsError } from "firebase-functions/v2/https";
import {
  pdfAttachmentFilename,
  renderPdfOrThrow,
} from "../../src/shared/documentPdf";

describe("pdfAttachmentFilename", () => {
  it("names the file for the business and the document", () => {
    expect(pdfAttachmentFilename("TechFlow Solutions", "INV-0001")).toBe(
      "TechFlow Solutions INV-0001.pdf",
    );
  });

  it("folds accents and drops characters mail clients mangle", () => {
    expect(pdfAttachmentFilename("Plomberie Côté", "INV-0002")).toBe(
      "Plomberie Cote INV-0002.pdf",
    );
    expect(pdfAttachmentFilename('A/B: "Pro" *Plumbing*', "QT-0003")).toBe(
      "AB Pro Plumbing QT-0003.pdf",
    );
  });

  it("falls back to the document number when no name is left", () => {
    expect(pdfAttachmentFilename("", "INV-0004")).toBe("INV-0004.pdf");
    expect(pdfAttachmentFilename(null, "INV-0005")).toBe("INV-0005.pdf");
    expect(pdfAttachmentFilename("日本", "INV-0006")).toBe("INV-0006.pdf");
  });

  it("caps a long business name", () => {
    const name = pdfAttachmentFilename("X".repeat(200), "INV-0007");
    expect(name).toBe(`${"X".repeat(60)} INV-0007.pdf`);
  });
});

describe("renderPdfOrThrow", () => {
  it("returns the rendered PDF's bytes", async () => {
    const bytes = await renderPdfOrThrow(
      async () => ({
        pdfBase64: Buffer.from("%PDF-1.7").toString("base64"),
        contentType: "application/pdf",
      }),
      "invoice",
    );
    expect(bytes.toString()).toBe("%PDF-1.7");
  });

  it("turns a render failure into a message the owner can act on", async () => {
    await expect(
      renderPdfOrThrow(async () => {
        throw new HttpsError("internal", "pdf-service error 500: Target closed");
      }, "quote"),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "Couldn't create the quote PDF, so the email wasn't sent. Try again in a minute.",
    });
  });

  it("passes a failed-precondition through unchanged", async () => {
    await expect(
      renderPdfOrThrow(async () => {
        throw new HttpsError("failed-precondition", "Invoice is missing tenantSnapshot.");
      }, "invoice"),
    ).rejects.toMatchObject({
      code: "failed-precondition",
      message: "Invoice is missing tenantSnapshot.",
    });
  });
});
