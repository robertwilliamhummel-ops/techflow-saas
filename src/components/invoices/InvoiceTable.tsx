import Link from "next/link";

import { InvoiceStatusBadge } from "@/components/invoices/InvoiceStatusBadge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { dollarsToCents, formatIsoDate, formatMoneyCents } from "@/lib/format";
import { displayInvoiceStatus } from "@/lib/invoices/dueStatus";
import type { Invoice } from "@/lib/schema/tenant";

export type InvoiceWithId = Invoice & { id: string };

export function invoiceHref(id: string): string {
  return `/invoices/${encodeURIComponent(id)}`;
}

/**
 * Invoice rows for the dashboard and the invoices list. On a phone the invoice
 * number sits under the customer and the status under the amount, so no column
 * runs off screen.
 */
export function InvoiceTable({
  invoices,
  today,
  showIssueDate = false,
}: {
  invoices: readonly InvoiceWithId[];
  today: string;
  showIssueDate?: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Customer</TableHead>
          {showIssueDate ? (
            <TableHead className="hidden md:table-cell">Issued</TableHead>
          ) : null}
          <TableHead className="hidden sm:table-cell">Due</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="hidden sm:table-cell">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoices.map((invoice) => {
          const status = displayInvoiceStatus(invoice, today);
          return (
            <TableRow key={invoice.id}>
              <TableCell>
                <Link
                  href={invoiceHref(invoice.id)}
                  className="block max-w-40 truncate font-medium underline-offset-4 hover:underline sm:max-w-64"
                >
                  {invoice.customer.name}
                </Link>
                <span className="block text-xs text-muted-foreground">
                  {invoice.id}
                </span>
              </TableCell>
              {showIssueDate ? (
                <TableCell className="hidden md:table-cell">
                  {formatIsoDate(invoice.issueDate)}
                </TableCell>
              ) : null}
              <TableCell className="hidden sm:table-cell">
                {formatIsoDate(invoice.dueDate)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMoneyCents(
                  dollarsToCents(invoice.totals.total),
                  invoice.tenantSnapshot.currency,
                )}
                <span className="mt-1 flex justify-end sm:hidden">
                  <InvoiceStatusBadge status={status} />
                </span>
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <InvoiceStatusBadge status={status} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
