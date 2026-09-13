// E-01 — PaymentReceipt template.

import { describe, expect, it } from "vitest";
import { render } from "@react-email/render";
import { createElement } from "react";
import {
  PaymentReceipt,
  buildPaymentReceiptPreviewText,
  type PaymentReceiptProps,
} from "../../src/emails/templates/PaymentReceipt";

function baseProps(
  overrides: Partial<PaymentReceiptProps> = {},
): PaymentReceiptProps {
  return {
    tenant: {
      name: "Acme Plumbing",
      address: "123 Main St, Toronto ON",
      logoUrl: null,
      emailFooter: "Licensed & insured",
      primaryColor: "#0066CC",
    },
    customerFirstName: "Jane",
    invoiceNumber: "INV-0042",
    amountPaidFormatted: "$524.30",
    paidOnFormatted: "September 13, 2026",
    paymentMethodLabel: "Credit card",
    cardFeeFormatted: null,
    portalUrl: "https://portal.techflowsolutions.ca/portal/login",
    ...overrides,
  };
}

async function renderHtml(props: PaymentReceiptProps): Promise<string> {
  const raw = await render(createElement(PaymentReceipt, props));
  // Strip React's <!-- --> separators and encoded apostrophes so assertions
  // match the intended text (same approach as the StaffInvite tests).
  return raw
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'");
}

async function renderText(props: PaymentReceiptProps): Promise<string> {
  return await render(createElement(PaymentReceipt, props), { plainText: true });
}

describe("PaymentReceipt template (E-01)", () => {
  it("confirms the amount, invoice, date, and payment method", async () => {
    const html = await renderHtml(baseProps());

    expect(html).toContain("Payment received");
    expect(html).toContain("Hi Jane,");
    expect(html).toContain(
      "Acme Plumbing received your payment of $524.30 for invoice INV-0042",
    );
    expect(html).toContain("Paid on: September 13, 2026");
    expect(html).toContain("Payment method: Credit card");
    expect(html).toContain("Amount paid: $524.30");
  });

  it("mentions the card fee only when one was charged", async () => {
    const withoutFee = await renderHtml(baseProps());
    expect(withoutFee).not.toContain("credit card fee");

    const withFee = await renderHtml(baseProps({ cardFeeFormatted: "$12.30" }));
    expect(withFee).toContain("Includes a $12.30 credit card fee");
  });

  it("has no CTA button, only a small portal link", async () => {
    const html = await renderHtml(baseProps());
    // The tenant colour is only ever used on the CTA button.
    expect(html).not.toContain("#0066CC");
    expect(html).toContain("View this invoice in your customer portal");
    expect(html).toContain('href="https://portal.techflowsolutions.ca/portal/login"');

    const withoutPortal = await renderHtml(baseProps({ portalUrl: null }));
    expect(withoutPortal).not.toContain("customer portal");
  });

  it("sanitizes tenant-controlled text", async () => {
    const html = await renderHtml(
      baseProps({
        tenant: { ...baseProps().tenant, name: "Acme Plumbing\r\nBcc: evil@x.com" },
      }),
    );
    expect(html).toContain("Acme Plumbing Bcc: evil@x.com");
    expect(html).not.toContain("Acme Plumbing\r\n");
  });

  it("renders a plain-text body with the same details", async () => {
    const text = await renderText(baseProps({ cardFeeFormatted: "$12.30" }));
    expect(text).toContain("Amount paid: $524.30");
    expect(text).toContain("Includes a $12.30 credit card fee");
    expect(text).toContain("Payment method: Credit card");
  });

  it("uses the shared layout's footer and dark-mode guard", async () => {
    const html = await renderHtml(baseProps());
    expect(html).toContain("Licensed &amp; insured");
    expect(html).toContain("Questions? Reply to this email.");
    expect(html.toLowerCase()).toContain('name="color-scheme"');
  });
});

describe("buildPaymentReceiptPreviewText", () => {
  it("summarises the payment for the inbox preview", () => {
    const preview = buildPaymentReceiptPreviewText(baseProps());
    expect(preview).toBe(
      "Payment of $524.30 received for invoice #INV-0042 — thank you from Acme Plumbing",
    );
    expect(preview.length).toBeLessThanOrEqual(110);
  });

  it("stays within 110 characters for a long business name", () => {
    const preview = buildPaymentReceiptPreviewText(
      baseProps({ tenant: { name: "x".repeat(100) } }),
    );
    expect(preview.length).toBeLessThanOrEqual(110);
  });
});
