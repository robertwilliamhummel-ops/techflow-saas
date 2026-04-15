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

const INVOICE_MAP: Record<InvoiceStatus, StatusBadgeProps> = {
  draft: { variant: "outline", label: "Draft" },
  sent: { variant: "default", label: "Sent" },
  viewed: { variant: "default", label: "Viewed" },
  partially_paid: { variant: "warning", label: "Partially paid" },
  paid: { variant: "success", label: "Paid" },
  overdue: { variant: "destructive", label: "Overdue" },
  void: { variant: "secondary", label: "Void" },
  refunded: { variant: "secondary", label: "Refunded" },
};

const QUOTE_MAP: Record<QuoteStatus, StatusBadgeProps> = {
  draft: { variant: "outline", label: "Draft" },
  sent: { variant: "default", label: "Sent" },
  viewed: { variant: "default", label: "Viewed" },
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
