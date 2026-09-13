// PaymentReceipt email template — "Payment received" (E-01).
//
// Sent to the customer when an invoice is paid: always for card payments made
// on the pay page, and for payments the business records itself (cash,
// e-Transfer) only when the owner asks for a receipt. It confirms what was
// paid and how; the invoice PDF stays the document. No CTA button — nothing
// is left to do — just a small link back to the portal.

import { Section, Text } from "@react-email/components";
import {
  TenantEmailLayout,
  type TenantSnapshotForEmail,
} from "../components/TenantEmailLayout";
import { sanitizeEmailField } from "../sanitize";

export interface PaymentReceiptProps {
  tenant: TenantSnapshotForEmail;
  customerFirstName: string;
  invoiceNumber: string;
  amountPaidFormatted: string;
  paidOnFormatted: string;
  paymentMethodLabel: string;
  // Card surcharge already included in amountPaidFormatted (D3), if any.
  cardFeeFormatted?: string | null;
  portalUrl?: string | null;
}

export function buildPaymentReceiptPreviewText(
  props: Pick<PaymentReceiptProps, "tenant" | "invoiceNumber" | "amountPaidFormatted">,
): string {
  const tenant = sanitizeEmailField(props.tenant.name, 80) || "your provider";
  const num = sanitizeEmailField(props.invoiceNumber, 30);
  const amount = sanitizeEmailField(props.amountPaidFormatted, 30);
  return `Payment of ${amount} received for invoice #${num} — thank you from ${tenant}`.slice(
    0,
    110,
  );
}

const rowStyle = { fontSize: "12px", color: "#6b7280", margin: "0 0 4px 0" };

export function PaymentReceipt(props: PaymentReceiptProps) {
  const safeTenantName =
    sanitizeEmailField(props.tenant.name, 100) || "Your provider";
  const safeName = sanitizeEmailField(props.customerFirstName, 100) || "there";
  const safeNumber = sanitizeEmailField(props.invoiceNumber, 30);
  const safeAmount = sanitizeEmailField(props.amountPaidFormatted, 30);
  const safePaidOn = sanitizeEmailField(props.paidOnFormatted, 40);
  const safeMethod = sanitizeEmailField(props.paymentMethodLabel, 40);
  const safeFee = sanitizeEmailField(props.cardFeeFormatted, 30);
  const preview = buildPaymentReceiptPreviewText(props);

  return (
    <TenantEmailLayout tenant={props.tenant} preview={preview}>
      <Section>
        <Text
          style={{
            fontSize: "18px",
            fontWeight: 600,
            margin: "0 0 12px 0",
            color: "#111111",
          }}
        >
          Payment received
        </Text>
        <Text
          style={{
            fontSize: "14px",
            lineHeight: "22px",
            margin: "0 0 8px 0",
            color: "#374151",
          }}
        >
          Hi {safeName},
        </Text>
        <Text
          style={{
            fontSize: "14px",
            lineHeight: "22px",
            margin: "0 0 16px 0",
            color: "#374151",
          }}
        >
          Thank you — {safeTenantName} received your payment of {safeAmount} for
          invoice {safeNumber}.
        </Text>
      </Section>

      <Section
        style={{
          backgroundColor: "#f9fafb",
          padding: "16px",
          borderRadius: "6px",
          margin: "0 0 16px 0",
        }}
      >
        <Text style={rowStyle}>Invoice: {safeNumber}</Text>
        <Text style={rowStyle}>Paid on: {safePaidOn}</Text>
        <Text style={rowStyle}>Payment method: {safeMethod}</Text>
        {safeFee ? (
          <Text style={rowStyle}>Includes a {safeFee} credit card fee</Text>
        ) : null}
        <Text
          style={{
            fontSize: "14px",
            fontWeight: 600,
            color: "#111111",
            margin: "0",
          }}
        >
          Amount paid: {safeAmount}
        </Text>
      </Section>

      {props.portalUrl ? (
        <Section>
          <Text
            style={{
              fontSize: "12px",
              lineHeight: "18px",
              color: "#6b7280",
              margin: "16px 0 0 0",
            }}
          >
            <a
              href={props.portalUrl}
              style={{ color: "#6b7280", textDecoration: "underline" }}
            >
              View this invoice in your customer portal
            </a>
          </Text>
        </Section>
      ) : null}
    </TenantEmailLayout>
  );
}
