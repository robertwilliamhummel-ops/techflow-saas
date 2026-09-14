import { Badge } from "@/components/ui/badge";
import { getInvoiceStatusBadgeProps } from "@/lib/invoices/statusBadge";
import type { InvoiceStatus } from "@/lib/schema/tenant";

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const { variant, label } = getInvoiceStatusBadgeProps(status);
  return <Badge variant={variant}>{label}</Badge>;
}
