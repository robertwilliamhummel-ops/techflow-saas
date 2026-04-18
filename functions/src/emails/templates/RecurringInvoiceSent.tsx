// RecurringInvoiceSent email template — "Your {frequency} invoice from {tenant} is ready."
//
// Blueprint line 1061 + line 1099. Same structure as InvoiceSent but with
// frequency context ("Your monthly invoice...") and no secondary portal link
// (the pay URL IS the action).

import { Section, Text } from "@react-email/components";
import {
  TenantEmailLayout,
  type TenantSnapshotForEmail,
} from "../components/TenantEmailLayout";
import { Button } from "../components/Button";
import { sanitizeEmailField } from "../sanitize";

export interface RecurringInvoiceSentProps {
  tenant: TenantSnapshotForEmail;
  customerFirstName: string;
  invoiceNumber: string;
  totalFormatted: string;
  dueDateFormatted: string;
  frequency: string; // e.g. "monthly", "weekly"
  payUrl: string;
}

export function buildRecurringInvoiceSentPreviewText(
  props: RecurringInvoiceSentProps,
): string {
  const tenant = sanitizeEmailField(props.tenant.name, 80) || "Your provider";
  const total = sanitizeEmailField(props.totalFormatted, 20);
  const freq = sanitizeEmailField(props.frequency, 20);
  return `Your ${freq} invoice from ${tenant} is ready — ${total}`.slice(
    0,
    110,
  );
}

export function RecurringInvoiceSent(props: RecurringInvoiceSentProps) {
  const safeTenantName =
    sanitizeEmailField(props.tenant.name, 100) || "Your provider";
  const safeName =
    sanitizeEmailField(props.customerFirstName, 100) || "there";
  const safeNumber = sanitizeEmailField(props.invoiceNumber, 30);
  const safeTotal = sanitizeEmailField(props.totalFormatted, 30);
  const safeDue = sanitizeEmailField(props.dueDateFormatted, 30);
  const safeFreq = sanitizeEmailField(props.frequency, 20);
  const preview = buildRecurringInvoiceSentPreviewText(props);

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
          Your {safeFreq} invoice is ready
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
          {safeTenantName} has generated your {safeFreq} invoice for{" "}
          {safeTotal}.
        </Text>
      </Section>

      <Section style={{ textAlign: "center", margin: "24px 0" }}>
        <Button href={props.payUrl} primaryColor={props.tenant.primaryColor}>
          Pay Invoice
        </Button>
      </Section>

      {/* Invoice summary */}
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
    </TenantEmailLayout>
  );
}
