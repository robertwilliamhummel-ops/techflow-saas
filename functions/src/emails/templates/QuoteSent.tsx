// QuoteSent email template — "You have a new quote from {tenant}."
//
// CTA links to the portal quote view. No pay action — quotes are not
// directly payable.

import { Section, Text } from "@react-email/components";
import {
  TenantEmailLayout,
  type TenantSnapshotForEmail,
} from "../components/TenantEmailLayout";
import { Button } from "../components/Button";
import { sanitizeEmailField } from "../sanitize";

export interface QuoteSentProps {
  tenant: TenantSnapshotForEmail;
  customerFirstName: string;
  quoteNumber: string;
  totalFormatted: string;
  validUntilFormatted: string;
  viewUrl: string;
}

export function buildQuoteSentPreviewText(props: QuoteSentProps): string {
  const tenant = sanitizeEmailField(props.tenant.name, 80) || "Your provider";
  const num = sanitizeEmailField(props.quoteNumber, 20);
  const total = sanitizeEmailField(props.totalFormatted, 20);
  const valid = sanitizeEmailField(props.validUntilFormatted, 20);
  return `Quote #${num} from ${tenant} — ${total}, valid until ${valid}`.slice(
    0,
    110,
  );
}

export function QuoteSent(props: QuoteSentProps) {
  const safeTenantName =
    sanitizeEmailField(props.tenant.name, 100) || "Your provider";
  const safeName =
    sanitizeEmailField(props.customerFirstName, 100) || "there";
  const safeNumber = sanitizeEmailField(props.quoteNumber, 30);
  const safeTotal = sanitizeEmailField(props.totalFormatted, 30);
  const safeValid = sanitizeEmailField(props.validUntilFormatted, 30);
  const preview = buildQuoteSentPreviewText(props);

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
          You have a new quote
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
          {safeTenantName} has sent you a quote for {safeTotal}.
        </Text>
      </Section>

      <Section style={{ textAlign: "center", margin: "24px 0" }}>
        <Button href={props.viewUrl} primaryColor={props.tenant.primaryColor}>
          View Quote
        </Button>
      </Section>

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
          Quote: {safeNumber}
        </Text>
        <Text
          style={{
            fontSize: "12px",
            color: "#6b7280",
            margin: "0 0 4px 0",
          }}
        >
          Valid until: {safeValid}
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
    </TenantEmailLayout>
  );
}
