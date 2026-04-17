// InvoiceSent email template — "You have a new invoice from {tenant}."
//
// Blueprint email design: single CTA "Pay Invoice" linking to /pay/{payToken}.
// No full line-item breakdown — that goes in the PDF and on the pay page.
// The email is the envelope, not the document.

import { Section, Text } from "@react-email/components";
import {
  TenantEmailLayout,
  type TenantSnapshotForEmail,
} from "../components/TenantEmailLayout";
import { Button } from "../components/Button";
import { sanitizeEmailField } from "../sanitize";

export interface InvoiceSentProps {
  tenant: TenantSnapshotForEmail;
  customerFirstName: string;
  invoiceNumber: string;
  totalFormatted: string;
  dueDateFormatted: string;
  payUrl: string;
  portalLoginUrl?: string | null;
}

export function buildInvoiceSentPreviewText(props: InvoiceSentProps): string {
  const tenant = sanitizeEmailField(props.tenant.name, 80) || "Your provider";
  const num = sanitizeEmailField(props.invoiceNumber, 20);
  const total = sanitizeEmailField(props.totalFormatted, 20);
  const due = sanitizeEmailField(props.dueDateFormatted, 20);
  return `Invoice #${num} from ${tenant} — ${total} due ${due}`.slice(0, 110);
}

export function InvoiceSent(props: InvoiceSentProps) {
  const safeTenantName =
    sanitizeEmailField(props.tenant.name, 100) || "Your provider";
  const safeName =
    sanitizeEmailField(props.customerFirstName, 100) || "there";
  const safeNumber = sanitizeEmailField(props.invoiceNumber, 30);
  const safeTotal = sanitizeEmailField(props.totalFormatted, 30);
  const safeDue = sanitizeEmailField(props.dueDateFormatted, 30);
  const preview = buildInvoiceSentPreviewText(props);

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
          You have a new invoice
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
          {safeTenantName} has sent you an invoice for {safeTotal}.
        </Text>
      </Section>

      <Section style={{ textAlign: "center", margin: "24px 0" }}>
        <Button href={props.payUrl} primaryColor={props.tenant.primaryColor}>
          Pay Invoice
        </Button>
      </Section>

      {/* Invoice summary — collapsed, just the essentials */}
      <Section
        style={{
          backgroundColor: "#f9fafb",
          padding: "16px",
          borderRadius: "6px",
          margin: "0 0 16px 0",
        }}
      >
        <Text
          style={{
            fontSize: "12px",
            color: "#6b7280",
            margin: "0 0 4px 0",
          }}
        >
          Invoice: {safeNumber}
        </Text>
        <Text
          style={{
            fontSize: "12px",
            color: "#6b7280",
            margin: "0 0 4px 0",
          }}
        >
          Due: {safeDue}
        </Text>
        <Text
          style={{
            fontSize: "14px",
            fontWeight: 600,
            color: "#111111",
            margin: "0",
          }}
        >
          Total: {safeTotal}
        </Text>
      </Section>

      {props.portalLoginUrl ? (
        <Section>
          <Text
            style={{
              fontSize: "12px",
              lineHeight: "18px",
              color: "#6b7280",
              margin: "16px 0 0 0",
            }}
          >
            Or{" "}
            <a
              href={props.portalLoginUrl}
              style={{ color: "#6b7280", textDecoration: "underline" }}
            >
              view in your customer portal
            </a>
          </Text>
        </Section>
      ) : null}
    </TenantEmailLayout>
  );
}
