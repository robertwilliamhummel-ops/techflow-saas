import type { InvoiceStatus, QuoteStatus } from "@/lib/schema/tenant";

type BadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "success"
  | "warning"
  | "outline";

export interface StatusBadgeProps {
  variant: BadgeVariant;
  label: string;
}

// Canonical mapping (REBUILD_PLAN Phase 1.5 "Status badge mapping"). Red is
// reserved for overdue; unpaid/sent use the tenant brand colour.
const INVOICE_MAP: Record<InvoiceStatus, StatusBadgeProps> = {
  draft: { variant: "outline", label: "Draft" },
  sent: { variant: "default", label: "Sent" },
  unpaid: { variant: "default", label: "Unpaid" },
  overdue: { variant: "destructive", label: "Overdue" },
  partial: { variant: "warning", label: "Partially paid" },
  paid: { variant: "success", label: "Paid" },
  refunded: { variant: "secondary", label: "Refunded" },
  "partially-refunded": { variant: "warning", label: "Partially refunded" },
};

const QUOTE_MAP: Record<QuoteStatus, StatusBadgeProps> = {
  draft: { variant: "outline", label: "Draft" },
  sent: { variant: "default", label: "Sent" },
  accepted: { variant: "success", label: "Accepted" },
  declined: { variant: "destructive", label: "Declined" },
  expired: { variant: "secondary", label: "Expired" },
  converted: { variant: "success", label: "Converted" },
};

export function getInvoiceStatusBadgeProps(
  status: InvoiceStatus,
): StatusBadgeProps {
  return INVOICE_MAP[status];
}

export function getQuoteStatusBadgeProps(status: QuoteStatus): StatusBadgeProps {
  return QUOTE_MAP[status];
}
