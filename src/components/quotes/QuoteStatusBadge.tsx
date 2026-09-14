import { Badge } from "@/components/ui/badge";
import { getQuoteStatusBadgeProps } from "@/lib/invoices/statusBadge";
import type { QuoteStatus } from "@/lib/schema/tenant";

export function QuoteStatusBadge({ status }: { status: QuoteStatus }) {
  const { variant, label } = getQuoteStatusBadgeProps(status);
  return <Badge variant={variant}>{label}</Badge>;
}
