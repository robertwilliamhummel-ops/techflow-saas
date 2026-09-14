import Link from "next/link";

import { QuoteStatusBadge } from "@/components/quotes/QuoteStatusBadge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { dollarsToCents, formatIsoDate, formatMoneyCents } from "@/lib/format";
import { displayQuoteStatus, quoteHref } from "@/lib/quotes/quoteStatus";
import type { Quote } from "@/lib/schema/tenant";

export type QuoteWithId = Quote & { id: string };

/**
 * Quote rows for the quotes list. Mirrors InvoiceTable: on a phone the quote
 * number sits under the customer and the status under the amount.
 */
export function QuoteTable({
  quotes,
  today,
}: {
  quotes: readonly QuoteWithId[];
  today: string;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Customer</TableHead>
          <TableHead className="hidden md:table-cell">Issued</TableHead>
          <TableHead className="hidden sm:table-cell">Valid until</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="hidden sm:table-cell">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {quotes.map((quote) => {
          const status = displayQuoteStatus(quote, today);
          return (
            <TableRow key={quote.id}>
              <TableCell>
                <Link
                  href={quoteHref(quote.id)}
                  className="block max-w-40 truncate font-medium underline-offset-4 hover:underline sm:max-w-64"
                >
                  {quote.customer.name}
                </Link>
                <span className="block text-xs text-muted-foreground">{quote.id}</span>
              </TableCell>
              <TableCell className="hidden md:table-cell">{formatIsoDate(quote.issueDate)}</TableCell>
              <TableCell className="hidden sm:table-cell">{formatIsoDate(quote.validUntil)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMoneyCents(dollarsToCents(quote.totals.total), quote.tenantSnapshot.currency)}
                <span className="mt-1 flex justify-end sm:hidden">
                  <QuoteStatusBadge status={status} />
                </span>
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <QuoteStatusBadge status={status} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
