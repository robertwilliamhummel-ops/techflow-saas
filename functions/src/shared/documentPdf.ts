// Invoice and quote PDFs, built from the document's frozen tenantSnapshot and
// rendered by the Cloud Run pdf-service. One builder for the preview callables
// and for every email that sends a document (D14), so the PDF a customer gets
// attached is exactly the one the business previews.

import { defineSecret } from "firebase-functions/params";
import { HttpsError } from "firebase-functions/v2/https";
import { pdfLogoDataUrl } from "./logo";
import { cardPaymentsReady } from "./payAmounts";
import { renderViaPdfService } from "./pdfService";
import { payPageUrl } from "./portalLinks";
import { effectiveCardSurcharge } from "./surcharge";

export const PDF_SERVICE_API_KEY = defineSecret("PDF_SERVICE_API_KEY");

export interface RenderedPdf {
  pdfBase64: string;
  contentType: string;
}

type Doc = Record<string, unknown>;

function frozenSnapshotOf(doc: Doc, noun: "Invoice" | "Quote"): Doc {
  const snapshot = doc.tenantSnapshot as Doc | undefined;
  if (!snapshot) {
    throw new HttpsError(
      "failed-precondition",
      `${noun} is missing tenantSnapshot.`,
    );
  }
  return snapshot;
}

function customerOf(doc: Doc): Doc {
  const customer = (doc.customer as Doc | undefined) ?? {};
  return {
    name: String(customer.name ?? ""),
    email: String(customer.email ?? ""),
    phone: typeof customer.phone === "string" ? customer.phone : null,
  };
}

function notesOf(doc: Doc): string | null {
  return typeof doc.notes === "string" ? doc.notes : null;
}

export async function renderInvoicePdf(params: {
  tenantId: string;
  invoiceId: string;
  invoice: Doc;
  /** The tenant's resolved feature flags this PDF depends on. */
  features: { cardSurcharge: boolean; stripePayments: boolean };
  /** Tenant meta: Stripe readiness, and the pay link's verified custom domain. */
  meta: Doc | undefined;
}): Promise<RenderedPdf> {
  const { tenantId, invoiceId, invoice } = params;
  const frozenSnapshot = frozenSnapshotOf(invoice, "Invoice");
  const snapshot = {
    ...frozenSnapshot,
    // D7 — the snapshot keeps only the logo copy's URL; the PDF needs the bytes.
    logo: await pdfLogoDataUrl(frozenSnapshot, tenantId),
    // D3 kill switch — the PDF never discloses a surcharge the platform won't charge.
    chargeCustomerCardFees: effectiveCardSurcharge(
      frozenSnapshot,
      params.features.cardSurcharge,
    ).enabled,
  };

  // A-12: a void invoice's PDF must not offer a way to pay it. The card
  // section (QR code and "pay online" link) appears only when the pay page
  // would offer a card — the same rule as verifyInvoicePayToken — so a
  // business on e-transfer alone never sends customers to a dead end (F-08).
  const cardReady =
    params.features.stripePayments && cardPaymentsReady(params.meta);
  const payToken =
    typeof invoice.payToken === "string" && invoice.status !== "void" && cardReady
      ? invoice.payToken
      : null;

  const data: Doc = {
    invoiceId,
    issueDate: String(invoice.issueDate ?? ""),
    dueDate: String(invoice.dueDate ?? ""),
    status: String(invoice.status ?? "draft"),
    customer: customerOf(invoice),
    lineItems: (invoice.lineItems as unknown[]) ?? [],
    totals: (invoice.totals as Doc) ?? {},
    notes: notesOf(invoice),
    paidVia:
      typeof invoice.paymentMethod === "string" && invoice.paymentMethod
        ? invoice.paymentMethod
        : null,
    paidAt: serializeTimestamp(invoice.paidAt),
    surchargeAmountCents:
      typeof invoice.surchargeAmountCents === "number"
        ? invoice.surchargeAmountCents
        : null,
    payUrl: payToken ? payPageUrl(params.meta, payToken) : null,
  };

  return await renderViaPdfService({
    path: "/render/invoice",
    body: { snapshot, data },
    apiKey: PDF_SERVICE_API_KEY.value(),
  });
}

export async function renderQuotePdf(params: {
  tenantId: string;
  quoteId: string;
  quote: Doc;
}): Promise<RenderedPdf> {
  const { tenantId, quoteId, quote } = params;
  const frozenSnapshot = frozenSnapshotOf(quote, "Quote");
  const snapshot = {
    ...frozenSnapshot,
    logo: await pdfLogoDataUrl(frozenSnapshot, tenantId),
  };

  const data: Doc = {
    quoteId,
    issueDate: String(quote.issueDate ?? ""),
    validUntil: String(quote.validUntil ?? ""),
    status: String(quote.status ?? "draft"),
    customer: customerOf(quote),
    lineItems: (quote.lineItems as unknown[]) ?? [],
    totals: (quote.totals as Doc) ?? {},
    notes: notesOf(quote),
  };

  return await renderViaPdfService({
    path: "/render/quote",
    body: { snapshot, data },
    apiKey: PDF_SERVICE_API_KEY.value(),
  });
}

// "TechFlow Solutions INV-0001.pdf": the business name keeps a customer's
// invoices from different businesses apart in their downloads folder. ASCII
// only (accents folded, anything else dropped) so every mail client shows the
// name unmangled; just the document number if no name survives.
export function pdfAttachmentFilename(
  businessName: unknown,
  documentId: string,
): string {
  const name = String(businessName ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 &.,'()-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return name ? `${name} ${documentId}.pdf` : `${documentId}.pdf`;
}

// D14: an email that sends a document must carry its PDF, so a render failure
// stops the send instead of mailing the envelope without the document. The
// message is shown to the business owner.
export async function renderPdfOrThrow(
  render: () => Promise<RenderedPdf>,
  noun: "invoice" | "quote",
): Promise<Buffer> {
  try {
    const pdf = await render();
    return Buffer.from(pdf.pdfBase64, "base64");
  } catch (err) {
    // Missing snapshot etc. already says what's wrong.
    if (err instanceof HttpsError && err.code === "failed-precondition") throw err;
    throw new HttpsError(
      "unavailable",
      `Couldn't create the ${noun} PDF, so the email wasn't sent. Try again in a minute.`,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
}

function serializeTimestamp(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const maybe = value as { toDate?: () => Date; seconds?: number };
    if (typeof maybe.toDate === "function") {
      return maybe.toDate().toISOString().slice(0, 10);
    }
    if (typeof maybe.seconds === "number") {
      return new Date(maybe.seconds * 1000).toISOString().slice(0, 10);
    }
  }
  return null;
}
